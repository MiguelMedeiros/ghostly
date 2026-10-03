import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupReader, BackupWriter, backupProtection, bytesSource, isCancelled, memorySink, readBackupHeader, type BackupHeader, type BackupRecord, type BackupSource } from "../src/backup/stream";
import { seal } from "../src/backup/envelope";
// covers: backup.envelope, backup.passphrase-rules, backup.stream, backup.unprotected

/** PBKDF2 at the real 600,000 rounds is slow on a loaded machine: run fewer, record what was asked. */
const asked: number[] = [];
beforeEach(() => {
  asked.length = 0;
  const derive = crypto.subtle.deriveKey.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "deriveKey").mockImplementation(((algorithm: Pbkdf2Params, ...rest: [CryptoKey, AesKeyGenParams, boolean, KeyUsage[]]) => {
    asked.push(algorithm.iterations);
    return derive({ ...algorithm, iterations: 1_000 }, ...rest);
  }) as typeof crypto.subtle.deriveKey);
});
afterEach(() => { vi.restoreAllMocks(); });

const PASS = "correct horse battery";
const MIB = 1024 * 1024;
/** Bytes that differ everywhere, so a frame out of place shows. */
const pattern = (length: number, seed = 7) => { const out = new Uint8Array(length); for (let i = 0; i < length; i++) out[i] = (i * 31 + seed * 17 + (i >> 8)) & 255; return out; };

async function make(passphrase: string | null, write: (writer: BackupWriter) => Promise<void>): Promise<Uint8Array> {
  const sink = memorySink();
  const writer = await BackupWriter.start(sink, passphrase);
  await write(writer);
  expect(await writer.finish()).toBe(sink.bytes().length);
  return sink.bytes();
}
async function readAll(bundle: Uint8Array | BackupSource, passphrase?: string): Promise<BackupRecord[]> {
  const reader = await BackupReader.open(bundle instanceof Uint8Array ? bytesSource(bundle) : bundle, passphrase);
  if (!reader) throw new Error("not version 2");
  const records: BackupRecord[] = [];
  for (let record = await reader.next(); record; record = await reader.next()) records.push(record.bytes ? { bytes: record.bytes.slice() } : record);
  return records;
}
const sample = (writer: BackupWriter) => (async () => {
  await writer.json(JSON.stringify({ t: "profile", name: "Diary" }));
  await writer.bytes(pattern(2 * MIB + 5));
  await writer.json(JSON.stringify({ t: "end" }));
})();
/** Where each frame of a bundle starts, after its header line. */
function frames(bundle: Uint8Array): { at: number; kind: number; length: number }[] {
  const out = [];
  for (let at = bundle.indexOf(10) + 1; at < bundle.length;) {
    const length = new DataView(bundle.buffer, bundle.byteOffset + at + 1, 4).getUint32(0);
    out.push({ at, kind: bundle[at], length });
    at += 5 + length;
  }
  return out;
}
/** Byte for byte, without the test runner walking millions of elements. */
const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b) === 0;
const joined = (records: BackupRecord[]) => { const parts = records.filter((r) => r.bytes).map((r) => r.bytes!); const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };

describe("a backup written a piece at a time (envelope version 2)", () => {
  it("comes back record for record with its passphrase, at 600,000 rounds, and nothing of it is readable without", async () => {
    const bundle = await make(PASS, sample);
    const header = JSON.parse(new TextDecoder().decode(bundle.subarray(0, bundle.indexOf(10)))) as BackupHeader;
    expect(header).toEqual({ format: "ghostly-backup", version: 2, protection: "passphrase", kdf: { name: "PBKDF2-SHA256", iterations: 600_000, salt: expect.stringMatching(/^[\w-]{22}$/) }, cipher: { name: "AES-256-GCM", nonce: expect.stringMatching(/^[\w-]{10}$/) } });
    expect(new TextDecoder("latin1").decode(bundle)).not.toContain("Diary");
    expect(await backupProtection(bytesSource(bundle))).toBe("passphrase");

    const records = await readAll(bundle, PASS);
    expect(records[0].json).toBe(JSON.stringify({ t: "profile", name: "Diary" }));
    expect(records[records.length - 1].json).toBe(JSON.stringify({ t: "end" }));
    // File bytes travel in frames of at most 1 MiB, in order.
    expect(records.filter((r) => r.bytes).map((r) => r.bytes!.length)).toEqual([MIB, MIB, 5]);
    expect(same(joined(records), pattern(2 * MIB + 5))).toBe(true);
    expect(asked).toEqual([600_000, 600_000]);
  });

  it("two backups of the same content share no salt, nonce or ciphertext", async () => {
    const [a, b] = [await make(PASS, sample), await make(PASS, sample)];
    const [ha, hb] = [a, b].map((bundle) => JSON.parse(new TextDecoder().decode(bundle.subarray(0, bundle.indexOf(10)))) as BackupHeader);
    expect(ha.kdf!.salt).not.toBe(hb.kdf!.salt);
    expect(ha.cipher!.nonce).not.toBe(hb.cipher!.nonce);
    const first = frames(a)[0];
    expect(a.slice(first.at + 5, first.at + 5 + 32)).not.toEqual(b.slice(frames(b)[0].at + 5, frames(b)[0].at + 5 + 32));
  });

  it("refuses the wrong passphrase, and a passphrase under 12 characters is never used to make one", async () => {
    const bundle = await make(PASS, sample);
    await expect(readAll(bundle, "not the passphrase")).rejects.toThrow("Wrong passphrase, or the backup was changed");
    await expect(readAll(bundle)).rejects.toThrow("Wrong passphrase, or the backup was changed");
    await expect(BackupWriter.start(memorySink(), "too short")).rejects.toThrow("Use at least 12 characters");
  });

  it("refuses a bundle cut short anywhere: in a frame, between frames, or just before the final marker", async () => {
    const bundle = await make(PASS, sample);
    const all = frames(bundle);
    const last = all[all.length - 1];
    expect(last.kind, "the final marker").toBe(255);
    for (const cut of [bundle.length - 1, last.at, all[2].at, all[2].at + 9, all[1].at + 5 + 100]) {
      await expect(readAll(bundle.slice(0, cut), PASS), `cut at ${cut}`).rejects.toThrow("This backup is damaged");
    }
    // Bytes added after the final marker are not a longer backup.
    const longer = new Uint8Array(bundle.length + 3);
    longer.set(bundle);
    await expect(readAll(longer, PASS)).rejects.toThrow("This backup is damaged");
  });

  it("refuses a changed byte, a frame moved, dropped, repeated or retyped, and a changed header", async () => {
    const bundle = await make(PASS, sample);
    const all = frames(bundle);
    const flip = (at: number) => { const copy = bundle.slice(); copy[at] ^= 1; return copy; };
    const without = (i: number) => { const f = all[i]; const copy = new Uint8Array(bundle.length - 5 - f.length); copy.set(bundle.subarray(0, f.at)); copy.set(bundle.subarray(f.at + 5 + f.length), f.at); return copy; };
    const cut = (i: number) => bundle.slice(all[i].at, all[i].at + 5 + all[i].length);
    const swapped = (() => { const copy = bundle.slice(); copy.set(cut(2), all[1].at); copy.set(cut(1), all[1].at + cut(2).length); return copy; })();
    const repeated = (() => { const f = cut(1); const copy = new Uint8Array(bundle.length + f.length); copy.set(bundle.subarray(0, all[2].at)); copy.set(f, all[2].at); copy.set(bundle.subarray(all[2].at), all[2].at + f.length); return copy; })();
    // A data frame relabelled as the final marker (to end the backup early), and the other way round.
    const retyped = (() => { const copy = bundle.slice(0, all[2].at + 5 + all[2].length); copy[all[2].at] = 255; return copy; })();

    await expect(readAll(flip(all[0].at + 9), PASS), "the first frame").rejects.toThrow("Wrong passphrase, or the backup was changed");
    for (const [name, damaged] of [["a byte of a file", flip(all[2].at + 300)], ["a tag", flip(all[2].at + 5 + all[2].length - 1)], ["dropped", without(2)], ["swapped", swapped], ["repeated", repeated], ["retyped", retyped]] as const) {
      await expect(readAll(damaged, PASS), name).rejects.toThrow("This backup is damaged");
    }
    // The clear header is part of every frame's check: another salt is another key, another nonce another seal.
    const header = new TextDecoder().decode(bundle.subarray(0, bundle.indexOf(10)));
    const reheaded = (change: (h: BackupHeader) => void) => { const h = JSON.parse(header) as BackupHeader; change(h); const line = new TextEncoder().encode(`${JSON.stringify(h)}\n`); const copy = new Uint8Array(line.length + bundle.length - all[0].at); copy.set(line); copy.set(bundle.subarray(all[0].at), line.length); return copy; };
    await expect(readAll(reheaded((h) => { h.kdf!.iterations = 600_001; }), PASS)).rejects.toThrow("Wrong passphrase, or the backup was changed");
    await expect(readAll(reheaded((h) => { (h as { note?: string }).note = "x"; }), PASS)).rejects.toThrow("Wrong passphrase, or the backup was changed");
  });

  it("refuses weaker, unbounded or unknown encryption, and a newer version, before deriving any key", async () => {
    const bundle = await make(PASS, sample);
    const header = JSON.parse(new TextDecoder().decode(bundle.subarray(0, bundle.indexOf(10)))) as BackupHeader;
    const withHeader = (change: (h: BackupHeader) => void) => { const h = structuredClone(header); change(h); return bytesSource(new TextEncoder().encode(`${JSON.stringify(h)}\nrest`)); };
    asked.length = 0;
    for (const change of [
      (h: BackupHeader) => { h.kdf!.iterations = 599_999; },
      (h: BackupHeader) => { h.kdf!.iterations = 10_000_001; },
      (h: BackupHeader) => { (h.kdf as { name: string }).name = "scrypt"; },
      (h: BackupHeader) => { delete h.kdf; },
      (h: BackupHeader) => { (h.cipher as { name: string }).name = "AES-128-CBC"; },
    ]) await expect(BackupReader.open(withHeader(change), PASS)).rejects.toThrow("Unsupported backup encryption");
    await expect(BackupReader.open(withHeader((h) => { (h as { protection: string }).protection = "rot13"; }), PASS)).rejects.toThrow("Unsupported backup format");
    // Version 3 is a bundle that carries a device set (WISP 06); one above it is a newer Ghostly's.
    await expect(BackupReader.open(withHeader((h) => { (h as { version: number }).version = 4; }), PASS)).rejects.toThrow("This backup comes from a newer Ghostly; update to restore it");
    // Stripping the encryption out of the header does not turn a sealed bundle into a readable one.
    const stripped = new TextEncoder().encode(`${JSON.stringify({ format: "ghostly-backup", version: 2, protection: "none", check: { name: "SHA-256-chain" } })}\n`);
    const forged = new Uint8Array(stripped.length + bundle.length - bundle.indexOf(10) - 1);
    forged.set(stripped); forged.set(bundle.subarray(bundle.indexOf(10) + 1), stripped.length);
    await expect(readAll(forged)).rejects.toThrow("This backup is damaged");
    expect(asked).toEqual([]);
  });

  it("a version 1 bundle, or anything else, is not taken for version 2", async () => {
    const one = new TextEncoder().encode(await seal("profile payload", PASS));
    expect(await readBackupHeader(bytesSource(one))).toBeNull();
    expect(await BackupReader.open(bytesSource(one), PASS)).toBeNull();
    expect(await backupProtection(bytesSource(one)), "version 1 is always sealed").toBe("passphrase");
    for (const text of ["", "not json\n", "{}\n", `${JSON.stringify({ format: "other", version: 2 })}\n`]) expect(await BackupReader.open(bytesSource(new TextEncoder().encode(text)), PASS), text).toBeNull();
  });

  it("stops when it is cancelled, writing or reading", async () => {
    const stop = new AbortController();
    const sink = memorySink();
    const writer = await BackupWriter.start(sink, PASS, stop.signal);
    await writer.json("{}");
    stop.abort();
    const failure = await writer.bytes(pattern(10)).catch((error: unknown) => error);
    expect(isCancelled(failure)).toBe(true);

    const bundle = await make(PASS, sample);
    const reading = new AbortController();
    const reader = (await BackupReader.open(bytesSource(bundle), PASS, reading.signal))!;
    expect((await reader.next())?.json).toContain("Diary");
    reading.abort();
    expect(isCancelled(await reader.next().catch((error: unknown) => error))).toBe(true);
  });

  it("a frame its sink refused ends the backup: nothing more is written after the gap", async () => {
    for (const passphrase of [PASS, null]) {
      const sink = memorySink();
      let refuse = false, asked = 0;
      const writer = await BackupWriter.start({ write: async (bytes) => { asked += 1; if (refuse) { refuse = false; throw Object.assign(new Error("no space left"), { name: "QuotaExceededError" }); } await sink.write(bytes); } }, passphrase);
      await writer.json("{}");
      refuse = true;
      await expect(writer.bytes(pattern(100))).rejects.toThrow("no space left");
      // The sink would take the next ones: the writer does not hand them over, and says why again.
      const before = asked;
      await expect(writer.json("{}")).rejects.toThrow("no space left");
      await expect(writer.finish()).rejects.toThrow("no space left");
      expect(asked).toBe(before);
    }
  });

  it("a piece of JSON a reader would refuse (over 64 MiB once compressed) is not written", async () => {
    // Random bytes as base64 text, 96 MiB of it: compression takes a quarter off at best, which leaves 72 MiB.
    const noise = crypto.getRandomValues.bind(crypto);
    let text = "";
    for (let i = 0; i < 96 * 16; i++) text += Buffer.from(noise(new Uint8Array(49_152))).toString("base64");
    const writer = await BackupWriter.start(memorySink(), PASS);
    await expect(writer.json(text)).rejects.toThrow("A record of this profile is too large for a backup");
  }, 120_000);

  it("reads a large bundle in ranges: the source is never asked for all of it", async () => {
    const bundle = await make(PASS, async (writer) => { await writer.json("{}"); await writer.bytes(pattern(9 * MIB)); });
    const asks: number[] = [];
    const source: BackupSource = { size: bundle.length, read: async (offset, length) => { asks.push(length); return bundle.subarray(offset, offset + length); } };
    expect(same(joined(await readAll(source, PASS)), pattern(9 * MIB))).toBe(true);
    expect(Math.max(...asks)).toBeLessThanOrEqual(4 * MIB);
    expect(asks.length).toBeLessThan(8);
  });
});

describe("a backup made without a passphrase", () => {
  it("says so in its header, opens with no passphrase, and derives no key", async () => {
    const bundle = await make(null, sample);
    expect(JSON.parse(new TextDecoder().decode(bundle.subarray(0, bundle.indexOf(10))))).toEqual({ format: "ghostly-backup", version: 2, protection: "none", check: { name: "SHA-256-chain" } });
    expect(await backupProtection(bytesSource(bundle))).toBe("none");
    const records = await readAll(bundle);
    expect(records[0].json).toBe(JSON.stringify({ t: "profile", name: "Diary" }));
    expect(same(joined(records), pattern(2 * MIB + 5))).toBe(true);
    // A passphrase typed anyway changes nothing.
    expect((await readAll(bundle, "whatever was typed")).length).toBe(records.length);
    expect(asked).toEqual([]);
  });

  it("is still checked: a changed byte, a missing frame or a cut file is refused", async () => {
    const bundle = await make(null, sample);
    const all = frames(bundle);
    const flip = (at: number) => { const copy = bundle.slice(); copy[at] ^= 1; return copy; };
    const without = (i: number) => { const f = all[i]; const copy = new Uint8Array(bundle.length - 5 - f.length); copy.set(bundle.subarray(0, f.at)); copy.set(bundle.subarray(f.at + 5 + f.length), f.at); return copy; };
    // The header is the first link of the chain: one that says more, or less, no longer matches the frames.
    const line = new TextEncoder().encode(`${JSON.stringify({ format: "ghostly-backup", version: 2, protection: "none", check: { name: "SHA-256-chain" }, note: "x" })}\n`);
    const reheaded = new Uint8Array(line.length + bundle.length - all[0].at);
    reheaded.set(line); reheaded.set(bundle.subarray(all[0].at), line.length);
    for (const [name, damaged] of [["a byte of a file", flip(all[2].at + 300)], ["a changed header", reheaded], ["the digest", flip(bundle.length - 1)], ["dropped", without(2)], ["cut", bundle.slice(0, all[all.length - 1].at)], ["cut in a frame", bundle.slice(0, all[2].at + 77)]] as const) {
      await expect(readAll(damaged), name).rejects.toThrow("This backup is damaged");
    }
  });
});

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync, statSync } from "node:fs";
import { once } from "node:events";
import { connect, expect, link, test, type Peer } from "../support/fixtures";

/**
 * Deterministic bytes, written to disk a step at a time: the test never holds the file either.
 * Returns its SHA-256 (hex).
 */
async function generate(path: string, size: number): Promise<string> {
  const out = createWriteStream(path);
  const hash = createHash("sha256");
  const step = 1024 * 1024;
  for (let offset = 0; offset < size; offset += step) {
    const part = Buffer.alloc(Math.min(step, size - offset));
    for (let i = 0; i < part.length; i++) part[i] = ((offset + i) * 31 + ((offset + i) >> 11)) & 0xff;
    hash.update(part);
    if (!out.write(part)) await once(out, "drain");
  }
  out.end();
  await once(out, "finish");
  return hash.digest("hex");
}

/** Sizes of this profile's files in the origin-private file system, by name. */
function opfsFiles(peer: Peer): Promise<Record<string, number>> {
  return peer.page.evaluate(async () => {
    const out: Record<string, number> = {};
    try {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("ghostly-files");
      const space = await root.getDirectoryHandle("ghostly");
      for await (const [name, handle] of (space as unknown as { entries(): AsyncIterable<[string, FileSystemFileHandle]> }).entries()) {
        out[name] = (await handle.getFile()).size;
      }
    } catch { /* none yet */ }
    return out;
  });
}

/** The IndexedDB record of each stored file: where its bytes are, and whether a Blob holds them. */
function fileRecords(peer: Peer): Promise<{ id: string; bytes?: string; blob: boolean }[]> {
  return peer.page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open("ghostly");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const all = open.result.transaction("files").objectStore("files").getAll();
      all.onsuccess = () => resolve(all.result.map((f: { id: string; bytes?: string; blob?: Blob }) => ({ id: f.id, bytes: f.bytes, blob: !!f.blob })));
      all.onerror = () => reject(all.error);
    };
  }));
}

test("a large file goes through file storage on both sides and arrives intact", { tag: ["@feature:files.storage", "@feature:files.paired.send"] }, async ({ peer }, testInfo) => {
  test.setTimeout(180_000);
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);

  // Above the 16 MiB kept whole in IndexedDB: the sender copies it into file storage first.
  const path = testInfo.outputPath("ghost archive.bin");
  const size = 40 * 1024 * 1024;
  const sha = await generate(path, size);
  await alice.page.getByTestId("file-input").setInputFiles(path);

  const bubble = bob.page.getByTestId("file-bubble").filter({ hasText: "ghost archive.bin" });
  await expect(bubble.getByTestId("file-save")).toBeVisible({ timeout: 150_000 });

  // Both copies live in the origin-private file system, not in a Blob in IndexedDB.
  for (const side of [alice, bob]) {
    const records = (await fileRecords(side)).filter((r) => r.bytes);
    expect(records, "one stored file on each side").toHaveLength(1);
    expect(records[0]).toMatchObject({ bytes: "opfs", blob: false });
    expect((await opfsFiles(side))[records[0].id]).toBe(size);
  }

  const download = bob.page.waitForEvent("download");
  await bubble.getByTestId("file-save").click();
  const saved = await (await download).path();
  expect(statSync(saved).size).toBe(size);
  expect(createHash("sha256").update(readFileSync(saved)).digest("hex")).toBe(sha);
});

/** SHA-256 (hex) of a file on disk, read as a stream. */
async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const part of createReadStream(path)) hash.update(part as Buffer);
  return hash.digest("hex");
}

/** The percentage a bubble shows now ("62% of …", "Waiting for connection · 62% done"), or -1. */
async function percent(bubble: ReturnType<Peer["page"]["getByTestId"]>): Promise<number> {
  const text = (await bubble.getByTestId("file-status").textContent().catch(() => "")) ?? "";
  const match = /(\d+)%/.exec(text);
  return match ? Number(match[1]) : -1;
}

test("a file over 25 MB waits for the receiver's answer; reloaded mid-way, it goes on from where it stood and arrives whole", { tag: ["@feature:files.large.offer", "@feature:files.large.resume", "@feature:files.large.integrity", "@feature:files.storage"] }, async ({ peer }, testInfo) => {
  test.setTimeout(300_000);
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);

  const path = testInfo.outputPath("season finale.mkv");
  const size = 300 * 1024 * 1024;
  const sha = await generate(path, size);
  await alice.page.getByTestId("file-input").setInputFiles(path);

  // Bob is asked, with his free space; Alice sees what she waits for.
  const incoming = bob.page.getByTestId("file-bubble").filter({ hasText: "season finale.mkv" });
  await expect(incoming.getByTestId("file-offer")).toContainText("wants to send season finale.mkv (300.0 MB)", { timeout: 60_000 });
  await expect(incoming.getByTestId("file-room")).toContainText("free on this device");
  const outgoing = alice.page.getByTestId("file-bubble").filter({ hasText: "season finale.mkv" });
  await expect(outgoing.getByTestId("file-status")).toContainText("to accept");
  await incoming.getByTestId("file-accept").click();

  // Well under way, Bob's app reloads.
  await expect.poll(() => percent(incoming), { timeout: 120_000 }).toBeGreaterThanOrEqual(30);
  const before = await percent(incoming);
  await bob.page.reload();
  const again = bob.page.getByTestId("file-bubble").filter({ hasText: "season finale.mkv" });
  await expect(again).toBeVisible({ timeout: 30_000 });
  // It goes on from its last durable point (every 8 MiB), not from zero.
  await expect.poll(() => percent(again), { timeout: 60_000 }).toBeGreaterThanOrEqual(before - 3);
  await expect(again.getByTestId("file-save")).toBeVisible({ timeout: 200_000 });
  await expect(outgoing.getByTestId("file-status")).toHaveText("300.0 MB", { timeout: 30_000 });

  const download = bob.page.waitForEvent("download");
  await again.getByTestId("file-save").click();
  const saved = await (await download).path();
  expect(statSync(saved).size).toBe(size);
  expect(await hashFile(saved)).toBe(sha);
});

test("a declined offer says so to the sender; a transfer cancelled by the sender ends on both sides", { tag: ["@feature:files.large.offer", "@feature:files.large.resume"] }, async ({ peer }, testInfo) => {
  test.setTimeout(180_000);
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);

  const first = testInfo.outputPath("not for me.bin");
  await generate(first, 30 * 1024 * 1024);
  await alice.page.getByTestId("file-input").setInputFiles(first);
  const offered = bob.page.getByTestId("file-bubble").filter({ hasText: "not for me.bin" });
  await offered.getByTestId("file-decline").click({ timeout: 60_000 });
  await expect(offered.getByTestId("file-status")).toHaveText("Failed: You declined it");
  const refused = alice.page.getByTestId("file-bubble").filter({ hasText: "not for me.bin" });
  await expect(refused.getByTestId("file-status")).toHaveText("Failed: Declined by your contact");
  await expect(refused.getByText("Retry sending")).toHaveCount(0);

  const second = testInfo.outputPath("changed my mind.bin");
  await generate(second, 200 * 1024 * 1024);
  await alice.page.getByTestId("file-input").setInputFiles(second);
  const receiving = bob.page.getByTestId("file-bubble").filter({ hasText: "changed my mind.bin" });
  await receiving.getByTestId("file-accept").click({ timeout: 60_000 });
  const sending = alice.page.getByTestId("file-bubble").filter({ hasText: "changed my mind.bin" });
  await expect.poll(() => percent(sending), { timeout: 60_000 }).toBeGreaterThanOrEqual(5);
  await sending.getByTestId("file-cancel").click();
  await expect(sending.getByTestId("file-status")).toHaveText("Failed: You cancelled it");
  await expect(receiving.getByTestId("file-status")).toHaveText("Failed: Cancelled by the sender", { timeout: 30_000 });
  // Nothing of it stays on Bob's side.
  await expect.poll(async () => Object.keys(await opfsFiles(bob)).length).toBe(0);
});

import { createHash } from "node:crypto";
import { createWriteStream, readFileSync, statSync } from "node:fs";
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

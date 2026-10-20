import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { profilePaths } from "../src/profiles";
import { isolatedNetworkEnv } from "./support/network";
// covers: delivery.hold.picture, storage.indexeddb

/*
 * A file that reached a CLI profile through held storage (hold/1, sent while it was away). Its bytes were a Blob in its
 * record, and the files store is held in memory and written whole into snapshot.bin: 60 held pictures of 8 MiB took a
 * daemon from 172 to 650 MB, and every start and one-shot read them all back.
 */
const root = mkdtempSync(join(tmpdir(), "ghostly-held-files-"));
const env = { ...isolatedNetworkEnv(), GHOSTLY_WEBRTC: "0" };
const before: Record<string, string | undefined> = {};
const MiB = 1024 * 1024;

beforeAll(() => { for (const [key, value] of Object.entries(env)) { before[key] = process.env[key]; process.env[key] = value; } });
afterAll(() => {
  for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(root, { recursive: true, force: true });
});

describe("a file that came through held storage", { timeout: 120_000 }, () => {
  it("is a file in the profile's folder, not bytes in its store", async () => {
    const paths = profilePaths(join(root, "home"), "held");
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    vi.resetModules();
    const { openHost } = await import("../src/host");
    const { callApi } = await import("../src/api");
    const { fileStore } = await import("@ghostly/browser/shared/idb");
    const host = await openHost(paths, "one-shot", "test");
    const ids: string[] = [];
    try {
      const { chat } = (await callApi(host.ctx, "invite.create", { label: "away" })) as { chat: string };
      const node = (host.ctx.runtime as unknown as { server: { node: { hold: { host: { receiveFile(linkId: string, wire: object, bytes: Uint8Array, digest: string): Promise<string | null> } } } } }).server.node;
      for (let i = 0; i < 4; i++) {
        const picture = new Uint8Array(4 * MiB).fill(i + 1);
        expect(await node.hold.host.receiveFile(chat, { wireId: `w${i}`, name: `p${i}.jpg`, size: picture.length, mime: "image/jpeg", timestamp: 1_000 + i }, picture, `d${i}`)).toBeNull();
      }
      for (const file of await fileStore.listForLink(chat)) {
        expect(file.blob).toBeUndefined();
        expect(file.bytes).toBe("native");
        ids.push(file.id);
      }
      expect(ids).toHaveLength(4);
    } finally { await host.close(); }

    // The store holds four small records; the bytes are four files beside it.
    expect(statSync(join(paths.db, "snapshot.bin")).size + (readdirSync(paths.db).includes("journal.bin") ? statSync(join(paths.db, "journal.bin")).size : 0)).toBeLessThan(MiB);
    for (const id of ids) expect(readdirSync(paths.files, { recursive: true }).some((name) => String(name).endsWith(id))).toBe(true);
  });

  it("taken before that, as a Blob in its record, moves to the profile's folder at the next open", async () => {
    const paths = profilePaths(join(root, "home"), "old");
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    const dbBytes = () => statSync(join(paths.db, "snapshot.bin")).size + (readdirSync(paths.db).includes("journal.bin") ? statSync(join(paths.db, "journal.bin")).size : 0);
    const pictures = [0, 1, 2, 3, 4].map((i) => new Uint8Array(4 * MiB).fill(i + 1));
    // As receiveFile wrote them before: the bytes in the record, a file state beside it.
    vi.resetModules();
    let host = await (await import("../src/host")).openHost(paths, "one-shot", "test");
    let chat: string;
    try {
      const { callApi } = await import("../src/api");
      ({ chat } = (await callApi(host.ctx, "invite.create", { label: "away" })) as { chat: string });
      const { fileStore } = await import("@ghostly/browser/shared/idb");
      for (const [i, picture] of pictures.entries()) {
        await fileStore.put({ id: `${chat}-in-old${i}`, linkId: chat, blob: new Blob([picture], { type: "image/jpeg" }), createdAt: 1_000 + i, direction: "in", wireId: `w${i}`, digest: `d${i}`,
          metadata: { name: `p${i}.jpg`, size: picture.length, mime: "image/jpeg", timestamp: 1_000 + i }, transfer: { state: "done", transferred: picture.length, size: picture.length } });
      }
      // What changed about a file after it was stored stays.
      await fileStore.patch(`${chat}-in-old0`, { digest: "e0" });
    } finally { await host.close(); }
    expect(dbBytes()).toBeGreaterThan(20 * MiB);

    // No files folder to be had: every file stays as it was, and still reads.
    rmSync(paths.files, { recursive: true, force: true });
    writeFileSync(paths.files, "");
    vi.resetModules();
    host = await (await import("../src/host")).openHost(paths, "one-shot", "test");
    try {
      const { fileStore } = await import("@ghostly/browser/shared/idb");
      const { callApi } = await import("../src/api");
      for (const [i, picture] of pictures.entries()) expect((await fileStore.get(`${chat}-in-old${i}`))?.blob?.size).toBe(picture.length);
      expect(await callApi(host.ctx, "file.save", { file: `${chat}-in-old1`, path: join(root, "kept.jpg") })).toMatchObject({ size: 4 * MiB });
      expect(new Uint8Array(readFileSync(join(root, "kept.jpg"))).every((byte) => byte === 2)).toBe(true);
    } finally { await host.close(); }
    rmSync(paths.files);

    vi.resetModules();
    host = await (await import("../src/host")).openHost(paths, "one-shot", "test");
    try {
      const { fileStore } = await import("@ghostly/browser/shared/idb");
      const { callApi } = await import("../src/api");
      for (const [i, picture] of pictures.entries()) {
        const stored = await fileStore.get(`${chat}-in-old${i}`);
        expect(stored?.blob).toBeUndefined();
        expect(stored).toMatchObject({ bytes: "native", digest: i ? `d${i}` : "e0", wireId: `w${i}`, metadata: { name: `p${i}.jpg`, size: picture.length } });
        const target = join(root, `saved-${i}.jpg`);
        expect(await callApi(host.ctx, "file.save", { file: `${chat}-in-old${i}`, path: target })).toMatchObject({ size: picture.length });
        expect(new Uint8Array(readFileSync(target)).every((byte) => byte === i + 1)).toBe(true);
      }
    } finally { await host.close(); }
    expect(dbBytes()).toBeLessThan(MiB);
  });
});

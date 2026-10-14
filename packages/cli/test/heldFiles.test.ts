import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
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
});

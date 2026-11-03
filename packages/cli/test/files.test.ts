import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NO_PICTURE_METADATA } from "@ghostly/core";
import { FILE_BYTES_STEP } from "@ghostly/browser/shared/fileBytes";
import type { EngineState, GroupView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { fitName, mimeOf, saveName } from "../src/files";
import { findMember, pictureFrom } from "../src/groupAdmin";
import { NodeFileBytes } from "../src/runtime/fileBytes";
// covers: headless.files, headless.group-admin

const folder = () => mkdtempSync(join(tmpdir(), "ghostly-files-"));
const fixtures = join(import.meta.dirname, "../../../e2e/support/avatar-fixtures");

describe("the Node file store", () => {
  it("appends in order, reads ranges, truncates, digests what is on disk, owner-only", async () => {
    const root = folder();
    const store = new NodeFileBytes(root);
    await store.append("f1", 0, new Uint8Array([1, 2, 3]));
    await expect(store.append("f1", 5, new Uint8Array([9]))).rejects.toThrow(/Append at 5/);
    await store.append("f1", 3, new Uint8Array([4, 5]));
    await store.flush("f1");
    await store.close("f1");
    expect(await store.size("f1")).toBe(5);
    expect(await store.read("f1", 1, 3)).toEqual(new Uint8Array([2, 3, 4]));
    await store.truncate("f1", 2);
    expect(await store.read("f1", 0, 10)).toEqual(new Uint8Array([1, 2]));
    const staged = await store.stage("f2", new Blob([new Uint8Array([1, 2])]));
    expect(staged).toBe(await store.digest("f1"));
    expect(await (await store.blob("f2", "text/plain"))!.arrayBuffer()).toEqual(new Uint8Array([1, 2]).buffer);
    expect(statSync(join(root, "ghostly", "f2")).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "ghostly")).mode & 0o777).toBe(0o700);
    await store.removeWhere("f");
    expect(await store.size("f1")).toBeNull();
    expect(await store.room()).toBeGreaterThan(0);
    await expect(store.size("../escape")).rejects.toThrow(/Invalid file id/);
  });

  it("stages a file in one read: its digest is hashed as it is copied, the same as one read from disk", async () => {
    const store = new NodeFileBytes(folder());
    const digest = vi.spyOn(store, "digest");
    // Over two steps and a part, and empty.
    const bytes = new Uint8Array(FILE_BYTES_STEP * 2 + 12_345).map((_, i) => (i * 31) & 0xff);
    const staged = await store.stage("big", new Blob([bytes]));
    const empty = await store.stage("empty", new Blob([]));
    expect(digest).not.toHaveBeenCalled();
    expect(staged).toBe(await store.digest("big"));
    expect(empty).toBe(await store.digest("empty"));
    expect(await store.size("big")).toBe(bytes.length);
    expect(await store.size("empty")).toBe(0);
  });

  it("fits a name in the 255 bytes a file system takes, keeping its extension", () => {
    expect(fitName("report.pdf")).toBe("report.pdf");
    const cjk = fitName(`${"文".repeat(120)}.txt`);
    expect(Buffer.byteLength(cjk)).toBeLessThanOrEqual(255);
    expect(cjk).toBe(`${"文".repeat(83)}.txt`);
    // Emoji are 4 bytes and never cut in half.
    const emoji = fitName("😀".repeat(100));
    expect(emoji).toBe("😀".repeat(63));
    expect(fitName(`${"é".repeat(200)}.tar`)).toBe(`${"é".repeat(125)}.tar`);
  });

  it("saves a file under a name no tool takes for an option: a leading dash gets a _ first", () => {
    expect(saveName("report.pdf")).toBe("report.pdf");
    expect(saveName("a-b--c.txt")).toBe("a-b--c.txt");
    expect(saveName("-rf")).toBe("_-rf");
    expect(saveName("-")).toBe("_-");
    expect(saveName("--checkpoint-action=exec=sh x.sh")).toBe("_--checkpoint-action=exec=sh x.sh");
    // What `sanitizeFileName` takes off the front (spaces, dots, invisible characters, separators) must not uncover one.
    for (const name of [" -x", ".-x", ". .-x", "\u200B-x", "/-x", "\\-x", ":-x", "\n-x"]) expect(saveName(name)).toBe("_-x");
    // The _ counts in the 255 bytes, and the extension stays.
    const long = saveName(`-${"文".repeat(120)}.txt`);
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(255);
    expect(long).toBe(`_-${"文".repeat(83)}.txt`);
    expect(saveName(`-${"a".repeat(199)}`)).toBe(`_-${"a".repeat(199)}`);
  });

  it("names types by extension, and never trusts a given one blindly", () => {
    expect(mimeOf("a/photo.JPG")).toBe("image/jpeg");
    expect(mimeOf("voice.webm")).toBe("audio/webm");
    expect(mimeOf("thing.bin")).toBe("application/octet-stream");
  });
});

describe("group administration", () => {
  const group = { name: "G", members: [{ key: "me", me: true }, { key: "abcd12", nick: "Ana", me: false }, { key: "abce34", nick: "Bo", me: false }] } as unknown as GroupView;
  it("finds members by key, prefix or name, never itself", () => {
    expect(findMember(group, "ana").key).toBe("abcd12");
    expect(findMember(group, "abce").key).toBe("abce34");
    expect(() => findMember(group, "abc")).toThrow(/more than one/);
    expect(() => findMember(group, "nobody")).toThrow(/No member/);
  });

  // This profile's own key or a prefix of it answered not_found "No member" as if it were not in the group.
  it("says a ref that names this profile itself is you, not that no member is there", () => {
    const own = { name: "Crew", members: [{ key: "595m389h77", me: true }, { key: "abcd12", nick: "Ana", me: false }] } as unknown as GroupView;
    for (const ref of ["595m389h77", "595m"]) {
      expect(() => findMember(own, ref)).toThrow(expect.objectContaining({ code: "bad_request", message: `${JSON.stringify(ref)} is you: name another member of Crew` }));
    }
    // This profile's own name too (its own row has none): "No member" read as if it were not in the group.
    for (const ref of ["Bia", "bia"]) {
      expect(() => findMember(own, ref, " Bia")).toThrow(expect.objectContaining({ code: "bad_request", message: `${JSON.stringify(ref)} is you: name another member of Crew` }));
    }
    expect(() => findMember(own, "Bo", "Bia")).toThrow(expect.objectContaining({ code: "not_found" }));
  });

  it("group admin, hub and remove say that this profile's own name is you", async () => {
    const own = { id: "g1", name: "Dev room", members: [{ key: "595m389h77", me: true }, { key: "abcd12", nick: "Ana", me: false }] } as unknown as GroupView;
    const node = { getState: () => ({ links: [], groups: [own], settings: { nick: "Bia" }, transport: {} }) as unknown as EngineState, makeGroupAdmin: vi.fn(), setGroupHub: vi.fn(), removeGroupMember: vi.fn() };
    const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
    for (const method of ["group.admin", "group.hub", "group.remove"]) {
      await expect(callApi(ctx, method, { group: "Dev room", member: "Bia" })).rejects.toMatchObject({ code: "bad_request", message: '"Bia" is you: name another member of Dev room' });
    }
    expect(node.makeGroupAdmin).not.toHaveBeenCalled();
  });

  it("a member's whole key is that member, whatever another member calls itself", () => {
    const KEY = "ybndrfg8ejkmcpqxot1uwisza345h769ybndrfg8ejkmcpqxot1o", OTHER = "o".repeat(52);
    const named = { name: "G", members: [{ key: "me", me: true }, { key: KEY, nick: "Bob", me: false }, { key: OTHER, nick: KEY, me: false }] } as unknown as GroupView;
    expect(findMember(named, KEY).key).toBe(KEY);
    expect(findMember(named, OTHER).key).toBe(OTHER);
    // A prefix and a name still stand side by side: two members is an error, never a guess.
    const prefixed = { name: "G", members: [{ key: "anaq77", nick: "Bo", me: false }, { key: "zzzz11", nick: "Ana", me: false }] } as unknown as GroupView;
    expect(() => findMember(prefixed, "ana")).toThrow(/more than one/);
  });

  it("takes a picture only as a JPEG within the bounds a contact checks", async () => {
    expect(await pictureFrom(join(fixtures, "avatar.jpg"))).toMatch(/^data:image\/jpeg;base64,\/9j/);
    await expect(pictureFrom(join(fixtures, "avatar.png"))).rejects.toMatchObject({ code: "bad_request" });
    await expect(pictureFrom(join(fixtures, "nothing.jpg"))).rejects.toMatchObject({ code: "not_found" });
  });

  it("takes a picture without the details saved in it, and refuses one they cannot be removed from", async () => {
    const SECRET = "GHOSTLY-SECRET-GPS 52.37N 4.89E";
    const ascii = (value: string) => [...value].map((c) => c.charCodeAt(0));
    const segment = (marker: number, body: number[]) => [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body];
    const jpegWith = (secret?: string) => Buffer.from([0xff, 0xd8,
      ...(secret ? segment(0xe1, [...ascii("Exif\0\0"), 0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, ...ascii(secret)]) : []),
      ...segment(0xdb, [0, ...new Array(64).fill(1)]), ...segment(0xc0, [8, 0, 128, 0, 128, 1, 1, 0x11, 0]),
      ...segment(0xc4, [0, ...new Array(16).fill(0)]), ...segment(0xda, [1, 1, 0, 0, 63, 0]), 0x12, 0x34, 0xff, 0xd9]);
    const dir = folder();
    writeFileSync(join(dir, "photo.jpg"), jpegWith(SECRET));
    const url = await pictureFrom(join(dir, "photo.jpg"));
    expect(Buffer.from(url.slice(url.indexOf(",") + 1), "base64")).toEqual(jpegWith());
    writeFileSync(join(dir, "cut.jpg"), jpegWith(SECRET).subarray(0, -2));
    await expect(pictureFrom(join(dir, "cut.jpg"))).rejects.toMatchObject({ code: "refused", message: NO_PICTURE_METADATA });
  });
});

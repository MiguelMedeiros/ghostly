import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GroupView } from "@ghostly/browser/shared/types";
import { mimeOf } from "../src/files";
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
    expect(() => findMember(group, "me")).toThrow(/No member/);
  });

  it("takes a picture only as a JPEG within the bounds a contact checks", async () => {
    expect(await pictureFrom(join(fixtures, "avatar.jpg"))).toMatch(/^data:image\/jpeg;base64,\/9j/);
    await expect(pictureFrom(join(fixtures, "avatar.png"))).rejects.toMatchObject({ code: "bad_request" });
    await expect(pictureFrom(join(fixtures, "nothing.jpg"))).rejects.toMatchObject({ code: "not_found" });
  });
});

import { describe, expect, it } from "vitest";
import { createIdentity } from "../src/identity";
import { MAX_AVATAR_LENGTH } from "../src/avatar";
import { epochKeys, newEpochSecret } from "../src/groupCrypto";
import {
  MAX_GROUP_META_BODY, MAX_GROUP_PICTURE_LENGTH, encodeGroupMetaBody, groupMetaNewer, groupMetaPicture, groupMetaTag, openGroupMeta, parseGroupMetaBody, parseGroupMetaFrame,
  parseGroupMetaStatement, parseGroupMetaTag, signGroupMeta, verifyGroupMetaSignature, wrapGroupMeta,
} from "../src/groupMeta";
// covers: groups.picture.protocol

function jpeg(width: number, height: number, padding = 0): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0xff, 0xda, 0x00, 0x02, ...new Array(padding).fill(0), 0xff, 0xd9]);
}
const url = (bytes: Uint8Array) => "data:image/jpeg;base64," + btoa(String.fromCharCode(...bytes));
const PIC = url(jpeg(128, 128));
const G = "AAAAAAAAAAAAAAAAAAAAAA";
const H = "a".repeat(64);

describe("group metadata body", () => {
  it("holds a picture Ghostly would show as a profile picture, and nothing else", () => {
    expect(JSON.parse(encodeGroupMetaBody({ pic: PIC }))).toEqual({ pic: PIC });
    expect(encodeGroupMetaBody({})).toBe("{}");
    expect(encodeGroupMetaBody({ pic: "" })).toBe("{}");
    for (const bad of ["https://tracker.example/pixel.jpg", "data:image/svg+xml;base64," + btoa("<svg onload=alert(1)>"), url(jpeg(4096, 4096)), url(jpeg(128, 128, MAX_AVATAR_LENGTH)), url(jpeg(128, 128, MAX_GROUP_PICTURE_LENGTH))])
      expect(() => encodeGroupMetaBody({ pic: bad }), bad.slice(0, 30)).toThrow(/cannot be used/);
  });
  it("reads a body: unknown fields ignored, no picture is none, anything unsafe refuses the whole body", () => {
    expect(parseGroupMetaBody(JSON.stringify({ pic: PIC, later: 1 }))).toEqual({ pic: PIC });
    expect(parseGroupMetaBody("{}")).toEqual({});
    expect(parseGroupMetaBody(JSON.stringify({ pic: "" }))).toEqual({});
    for (const bad of ["", "[]", "null", "not json", JSON.stringify({ pic: "https://example.com/a.jpg" }), JSON.stringify({ pic: url(jpeg(0, 10)) }),
      JSON.stringify({ pic: 7 }), JSON.stringify({ x: "y".repeat(MAX_GROUP_META_BODY) }), JSON.stringify({ pic: url(jpeg(128, 128, MAX_GROUP_PICTURE_LENGTH)) })])
      expect(parseGroupMetaBody(bad), bad.slice(0, 30)).toBeNull();
  });
});

describe("group metadata statement and frame", () => {
  const admin = createIdentity(), other = createIdentity();
  const secret = newEpochSecret();
  const key = epochKeys(secret, G, 3).message;
  const meta = signGroupMeta({ g: G, e: 3, h: H, r: 2, ts: 1000 }, encodeGroupMetaBody({ pic: PIC }), admin.seed, admin.pubKeyZ32);

  it("is signed by the admin over the body's hash, and opens under the epoch's key it names", () => {
    expect(verifyGroupMetaSignature(meta)).toBe(true);
    const frame = wrapGroupMeta(meta, 3, key);
    expect(frame).toMatchObject({ t: "group-meta", g: G, e: 3, h: H, r: 2, by: admin.pubKeyZ32, k: 3 });
    expect(frame).not.toHaveProperty("v");
    expect(JSON.stringify(frame)).not.toContain(PIC.slice(30, 60));
    const parsed = parseGroupMetaFrame(JSON.parse(JSON.stringify(frame)))!;
    const opened = openGroupMeta(parsed, key)!;
    expect(opened.body).toEqual({ pic: PIC });
    expect(opened.meta).toEqual(meta);
    expect(groupMetaPicture(opened.meta)).toBe(PIC);
    expect(wrapGroupMeta(meta, H, key, true)).toMatchObject({ v: 2, k: H });
  });

  it("refuses a forged or altered statement", () => {
    // Someone else's key under the admin's name.
    const forged = signGroupMeta({ g: G, e: 3, h: H, r: 9, ts: 1000 }, "{}", other.seed, admin.pubKeyZ32);
    expect(verifyGroupMetaSignature(forged)).toBe(false);
    for (const change of [{ r: 3 }, { e: 4 }, { h: "b".repeat(64) }, { g: "BBBBBBBBBBBBBBBBBBBBBB" }, { d: "c".repeat(64) }, { by: other.pubKeyZ32 }, { ts: 2 }])
      expect(verifyGroupMetaSignature({ ...meta, ...change }), JSON.stringify(change)).toBe(false);
  });

  it("does not open under another epoch's key, another key reference, or with a body that is not the signed one", () => {
    const frame = parseGroupMetaFrame(wrapGroupMeta(meta, 3, key))!;
    expect(openGroupMeta(frame, epochKeys(secret, G, 4).message)).toBeNull();
    expect(openGroupMeta({ ...frame, k: 4 }, key)).toBeNull();
    // A body boxed correctly but not the one the statement's hash names.
    const swapped = parseGroupMetaFrame(wrapGroupMeta({ ...meta, body: "{}" }, 3, key))!;
    expect(openGroupMeta(swapped, key)).toBeNull();
    // A signed hash of an unsafe body opens and is still refused.
    const unsafe = signGroupMeta({ g: G, e: 3, h: H, r: 3, ts: 1 }, JSON.stringify({ pic: "https://tracker.example/a.jpg" }), admin.seed, admin.pubKeyZ32);
    expect(openGroupMeta(parseGroupMetaFrame(wrapGroupMeta(unsafe, 3, key))!, key)).toBeNull();
  });

  it("fits the largest picture in one edge frame (60 KiB)", () => {
    // Base64 grows by 4/3: the largest padding whose data URL is still within the bound.
    const padding = Math.floor((MAX_GROUP_PICTURE_LENGTH - url(jpeg(128, 128)).length) * 3 / 4);
    const pic = url(jpeg(128, 128, padding));
    expect(pic.length).toBeLessThanOrEqual(MAX_GROUP_PICTURE_LENGTH);
    expect(pic.length).toBeGreaterThan(MAX_GROUP_PICTURE_LENGTH - 8);
    const big = signGroupMeta({ g: G, e: 1_000_000, h: H, r: 1_000_000, ts: Date.now() }, encodeGroupMetaBody({ pic }), admin.seed, admin.pubKeyZ32);
    const frame = JSON.stringify(wrapGroupMeta(big, H, key, true));
    expect(frame.length).toBeLessThan(60 * 1024);
    expect(parseGroupMetaFrame(JSON.parse(frame))).not.toBeNull();
  });

  it("drops malformed frames and statements", () => {
    const frame = wrapGroupMeta(meta, 3, key) as unknown as Record<string, unknown>;
    for (const change of [{ t: "group-msg" }, { k: -1 }, { k: "xyz" }, { nn: "short" }, { c: "!!" }, { c: "A".repeat(100_000) }, { r: 0 }, { e: -1 }, { h: "zz" }, { by: "nope" }, { sig: "x" }, { d: 5 }, { ts: 0 }])
      expect(parseGroupMetaFrame({ ...frame, ...change }), JSON.stringify(change).slice(0, 30)).toBeNull();
    expect(parseGroupMetaFrame(null)).toBeNull();
    expect(parseGroupMetaStatement("x")).toBeNull();
    expect(parseGroupMetaStatement(meta)).toEqual((({ body: _body, ...s }) => s)(meta));
  });

  it("orders statements by commit, then revision, and says which one a member holds", () => {
    expect(groupMetaNewer({ e: 3, r: 1 }, undefined)).toBe(true);
    expect(groupMetaNewer({ e: 4, r: 1 }, { e: 3, r: 9 })).toBe(true);
    expect(groupMetaNewer({ e: 3, r: 2 }, { e: 3, r: 1 })).toBe(true);
    expect(groupMetaNewer({ e: 3, r: 1 }, { e: 3, r: 1 })).toBe(false);
    expect(groupMetaNewer({ e: 2, r: 9 }, { e: 3, r: 1 })).toBe(false);
    expect(groupMetaTag(meta)).toBe("3.2");
    expect(groupMetaTag(undefined)).toBe("");
    expect(parseGroupMetaTag("3.2")).toEqual({ e: 3, r: 2 });
    expect(parseGroupMetaTag("")).toBeUndefined();
    for (const bad of [undefined, 3, "3", "a.b", "-1.2", "1.2.3"]) expect(parseGroupMetaTag(bad)).toBeNull();
  });
});

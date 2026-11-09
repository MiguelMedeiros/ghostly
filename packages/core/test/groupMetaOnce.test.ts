import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { sanitizeAvatar } from "../src/avatar";
import { GroupSession, type GroupState } from "../src/groupSession";
import { CommunitySession, type CommunityState } from "../src/groupCommunity";
import { encodeGroupMetaBody, groupDisplayName, groupMetaBody, groupMetaPicture, signGroupMeta, type GroupMeta } from "../src/groupMeta";
// covers: groups.picture.protocol, groups.rename.protocol

// Count every picture check the group metadata makes, still doing the real check.
vi.mock("../src/avatar", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/avatar")>();
  return { ...actual, sanitizeAvatar: vi.fn(actual.sanitizeAvatar) };
});
const checks = vi.mocked(sanitizeAvatar);

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
function jpeg(side: number, fill = 0): string {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, side >> 8, side & 255, side >> 8, side & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return "data:image/jpeg;base64," + btoa(String.fromCharCode(0xff, 0xd8, ...app0, ...sof, 0xff, 0xda, 0x00, 0x02, fill, 0xff, 0xd9));
}
const RED = jpeg(128, 1), BLUE = jpeg(128, 2), HUGE = jpeg(4096, 3);

const groupHooks = { save: async () => {}, send: () => {}, message: () => {}, changed: () => {} };
const communityHooks = { save: async () => {}, broadcast: () => {}, direct: () => {}, addressed: () => {}, message: () => {}, changed: () => {} };

/** A statement signed by hand, with any body (`encodeGroupMetaBody` refuses a picture Ghostly would not show). */
function statement(body: string): GroupMeta {
  const seed = createIdentity().seedB64;
  const id = identityFromSeedB64(seed);
  return signGroupMeta({ g: "a".repeat(22), e: 0, h: "0".repeat(64), r: 1, ts: 1 }, body, id.seed, id.pubKeyZ32);
}

beforeEach(() => { checks.mockClear(); });

describe("a group's picture is checked once per statement, not at every read", () => {
  it("private group: reading the name and the picture again and again checks the picture once", async () => {
    const state: GroupState = GroupSession.create("Ghosts");
    const alice = new GroupSession(state, groupHooks);
    await alice.setPicture(RED);
    checks.mockClear();
    for (let i = 0; i < 50; i++) { expect(alice.name).toBe("Ghosts"); expect(alice.picture).toBe(RED); }
    expect(checks.mock.calls.length).toBeLessThanOrEqual(1);
    // A new picture is a new statement: read at once, then once again for all later reads.
    await alice.setPicture(BLUE);
    checks.mockClear();
    for (let i = 0; i < 50; i++) expect(alice.picture).toBe(BLUE);
    expect(checks.mock.calls.length).toBeLessThanOrEqual(1);
    await alice.setPicture(null);
    expect(alice.picture).toBeUndefined();
  });

  it("community: the same, and a copy restored from what was saved checks it once too", async () => {
    let saved: CommunityState | undefined;
    const state = CommunitySession.create("Ghosts");
    const alice = new CommunitySession(state, { ...communityHooks, save: async (s: CommunityState) => { saved = clone(s); } });
    await alice.setPicture(RED);
    await alice.rename("Book club");
    checks.mockClear();
    for (let i = 0; i < 50; i++) { expect(alice.name).toBe("Book club"); expect(alice.picture).toBe(RED); }
    expect(checks.mock.calls.length).toBeLessThanOrEqual(1);

    const restored = new CommunitySession(saved!, communityHooks);
    checks.mockClear();
    for (let i = 0; i < 50; i++) { expect(restored.name).toBe("Book club"); expect(restored.picture).toBe(RED); }
    expect(checks).toHaveBeenCalledTimes(1);

    await alice.setPicture(BLUE);
    expect([alice.picture, alice.name]).toEqual([BLUE, "Book club"]);
  });

  it("a picture Ghostly does not show is still refused, at every read", () => {
    const bad = statement(JSON.stringify({ name: "Ghosts", pic: HUGE }));
    for (let i = 0; i < 3; i++) {
      expect(groupMetaPicture(bad)).toBeUndefined();
      // The whole body is refused with its picture, as before: the name falls back to the first one.
      expect(groupDisplayName(bad, "First")).toBe("First");
      expect(groupMetaBody(bad)).toEqual({});
    }
    expect(checks).toHaveBeenCalledTimes(1);
    expect(() => encodeGroupMetaBody({ pic: HUGE })).toThrow("This picture cannot be used");
  });

  it("a statement whose body is replaced in place is read again, and a caller changing what it got changes nothing kept", () => {
    const [hub, other] = [createIdentity().pubKeyZ32, createIdentity().pubKeyZ32];
    const meta = statement(encodeGroupMetaBody({ name: "Ghosts", pic: RED, hubs: { pin: [hub], no: [] } }));
    expect(groupMetaPicture(meta)).toBe(RED);
    const body = groupMetaBody(meta);
    body.name = "Changed";
    body.hubs!.pin.push(other);
    expect(groupMetaBody(meta)).toEqual({ name: "Ghosts", pic: RED, hubs: { pin: [hub], no: [] } });

    meta.body = encodeGroupMetaBody({ pic: BLUE });
    expect(groupMetaPicture(meta)).toBe(BLUE);
    expect(groupDisplayName(meta, "First")).toBe("First");
  });
});

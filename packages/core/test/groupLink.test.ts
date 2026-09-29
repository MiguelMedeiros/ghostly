import { expect, it, vi } from "vitest";
import { GhostLink, type GhostLinkEvents } from "../src/ghostlink";
import { createLink } from "../src/invite";
import { createIdentity } from "../src/identity";
import { createChannelPair } from "./helpers";
// covers: core.capabilities, groups.protocol.link-frames

/** Two paired links attached to the two ends of one in-memory channel, as if WebRTC had opened it. */
function attachedPair(events: [GhostLinkEvents, GhostLinkEvents], groups: [boolean, boolean]) {
  const invitation = createLink();
  const [ca, cb] = createChannelPair();
  const make = (params: typeof invitation.mine, i: 0 | 1) => {
    const link = new GhostLink({ params: { ...params, profile: "paired-chat/1" }, groupsSupport: groups[i],
      pairing: { credentials: { seedB64: createIdentity().seedB64 }, pinPeer: vi.fn(async () => {}), trustOnFirstUse: true },
      transport: { publish: vi.fn(async () => {}), resolve: async () => null, describe: () => ({ protocol: "test", relays: [] }) },
      createPeerConnection: () => { throw new Error("no dial in this test"); }, localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined, events: events[i] });
    Object.defineProperty(link.dataLink, "fingerprints", { get: () => ["a".repeat(64), "b".repeat(64)] });
    return link;
  };
  const a = make(invitation.mine, 0), b = make(invitation.invite, 1);
  (a as unknown as { attach(c: unknown): void }).attach(ca);
  (b as unknown as { attach(c: unknown): void }).attach(cb);
  return { a, b };
}

it("carries group frames only once both sides announced groups on the open session", async () => {
  const framesA = vi.fn(), framesB = vi.fn(), supportA = vi.fn(), supportB = vi.fn();
  const { a, b } = attachedPair([{ onGroupFrame: framesA, onGroupsSupport: supportA }, { onGroupFrame: framesB, onGroupsSupport: supportB }], [true, true]);
  await vi.waitFor(() => { expect(a.groupsSupport).toBe(true); expect(b.groupsSupport).toBe(true); });
  expect(supportA).toHaveBeenLastCalledWith(true);
  a.sendGroupFrame({ t: "group-invite", g: "x" });
  await vi.waitFor(() => expect(framesB).toHaveBeenCalledWith({ t: "group-invite", g: "x" }));
  expect(() => a.sendGroupFrame({ t: "group-msg", c: "x".repeat(70 * 1024) })).toThrow(/too large/);
  a.disconnect();
  await vi.waitFor(() => expect(supportA).toHaveBeenLastCalledWith(false));
  expect(a.groupsSupport).toBe(false);
  expect(() => a.sendGroupFrame({ t: "group-invite", g: "x" })).toThrow();
  await Promise.all([a.stop(false), b.stop(false)]);
});

it("an app without groups never sees a group frame, and a contact on it cannot be invited", async () => {
  const framesOld = vi.fn(), messagesOld = vi.fn();
  const { a, b } = attachedPair([{ onGroupFrame: vi.fn() }, { onGroupFrame: framesOld, onMessage: messagesOld }], [true, false]);
  await vi.waitFor(() => expect(b.isDataLinkOpen).toBe(true));
  await vi.waitFor(() => expect(a.isDataLinkOpen).toBe(true));
  // The announcement went out; the old side did not answer it, so groups stay off here.
  await new Promise(r => setTimeout(r, 20));
  expect(a.groupsSupport).toBe(false);
  expect(b.groupsSupport).toBe(false);
  expect(() => a.sendGroupFrame({ t: "group-invite", g: "x" })).toThrow(/updated Ghostly/);
  // A group frame smuggled in anyway is dropped on the side without groups, and so is a foreign frame without an id.
  (a as unknown as { channel: { send(d: string): void } }).channel.send(JSON.stringify({ t: "group-invite", g: "x" }));
  expect(await a.sendMessage("still a chat")).toBeNull();
  await vi.waitFor(() => expect(messagesOld).toHaveBeenCalled());
  expect(framesOld).not.toHaveBeenCalled();
  await Promise.all([a.stop(false), b.stop(false)]);
});

it("announces both group versions; an app with only the mesh keeps mesh groups and never gets community ones", async () => {
  const { a, b } = attachedPair([{ onGroupFrame: vi.fn() }, { onGroupFrame: vi.fn() }], [true, true]);
  await vi.waitFor(() => { expect(a.supportsGroupVersion(2)).toBe(true); expect(b.supportsGroupVersion(2)).toBe(true); });
  expect(a.supportsGroupVersion(1)).toBe(true);
  // The other side is an app from before community groups: it announces the mesh only.
  (b as unknown as { channel: { send(d: string): void } }).channel.send(JSON.stringify({ t: "paired-groups", v: [1] }));
  await vi.waitFor(() => expect(a.supportsGroupVersion(2)).toBe(false));
  expect(a.groupsSupport).toBe(true);
  expect(a.supportsGroupVersion(1)).toBe(true);
  await Promise.all([a.stop(false), b.stop(false)]);
});

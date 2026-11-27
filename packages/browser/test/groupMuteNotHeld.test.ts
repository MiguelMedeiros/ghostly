import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { p256 } from "@noble/curves/nist.js";
import { createIdentity, generateVapidKeys, toBase64Url } from "@ghostly/core";
import { EngineServer } from "../src/engine/server";
import type { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import type { StoredLink, WakeSubscription } from "../src/shared/types";
// covers: push.wake.mute, push.wake.group

/**
 * A wake-up mute asked for a group this profile no longer holds (left, or removed and deleted) saves nothing. It was
 * saved, so the group came back muted when joined again: no member got a wake token, and it showed muted. ghostly#9056
 * dropped the mute of a group that ended while the mute waited; this is the mute asked after the end.
 */
const fixture = { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) };
const servers: EngineServer[] = [];

async function started(): Promise<GhostlyNode> {
  const server = new EngineServer({ automaticWallets: false, transport: fixture });
  servers.push(server);
  await server.ready;
  server.attach({ post: () => {} });
  return server.node;
}
/** The app closed and opened again: a new engine over what the first one saved. */
async function restarted(node: GhostlyNode): Promise<GhostlyNode> {
  const index = servers.findIndex(server => server.node === node);
  await servers.splice(index, 1)[0]!.node.shutdown();
  return started();
}

function subscription(): WakeSubscription {
  const secret = p256.utils.randomSecretKey();
  return { endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: toBase64Url(p256.getPublicKey(secret, false)), auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))), vapid: generateVapidKeys() };
}

/** A member's edge in the group, as one joined again opens: the frames said over it are kept. */
async function edgeTo(node: GhostlyNode, groupId: string) {
  const session = { setActive: vi.fn(), pollNow: vi.fn(), setFastPoll: vi.fn() };
  const link = { setChatActive: (active: boolean) => session.setActive(active), session,
    isDataLinkOpen: true, supportsWake: true, sendWake: vi.fn(() => true), textDelivery: "unavailable", availableTransports: ["webrtc/1"],
    allowsPayment: vi.fn(() => true), paymentEnabled: vi.fn(() => true), setHoldSupport: vi.fn(), refreshServices: vi.fn(async () => {}),
    request: vi.fn(async () => ({ status: 200 })), sendMessage: vi.fn(async () => null), validateText: vi.fn(() => null),
    setNick: vi.fn(), setAvatar: vi.fn(), stop: vi.fn(async () => {}), depart: vi.fn(async () => {}), wake: vi.fn(), setTyping: vi.fn(),
    groupsSupport: true, sendGroupFrame: vi.fn() };
  vi.spyOn(node["groups"], "inRoster").mockReturnValue(true);
  const row: StoredLink = { id: `edge-${crypto.randomUUID().slice(0, 8)}`, createdAt: 1, seedB64: createIdentity().seedB64, encKeyB64: createIdentity().seedB64,
    peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64, group: groupId, groupPeer: createIdentity().pubKeyZ32 } as StoredLink;
  await db.putLink(row);
  node["links"].set(row.id, { stored: row, myPubKeyZ32: "me", link: link as never, status: "online", dataLink: "open",
    presence: { online: true, lastPacketAt: 0, services: null }, lastMessageAt: 0, peerAck: 0, lastSyncAt: 0,
    poll: { polling: false, nextAt: 0, interval: 0 }, files: { receivedBytes: 0, wireIds: new Set(), incoming: new Map() } } as never);
  await node["shareGroupWake"](row.id);
  return (link.sendGroupFrame.mock.calls.at(-1)?.[0] as { w: { k: string } | null } | undefined)?.w;
}

const mutedOnDisk = async () => (await db.getSettings()).wakeMutedGroups;
const shownMuted = (node: GhostlyNode, id: string, profile: "mesh" | "community") => !!node["groupWakeView"]({ id, profile } as never).wakeMuted;

beforeEach(async () => {
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await transact([STORES.links, STORES.messages, STORES.groups], (s) => { for (const n of [STORES.links, STORES.messages, STORES.groups]) s[n].clear(); });
});
afterEach(async () => { for (const server of servers.splice(0)) await server.node.shutdown(); vi.restoreAllMocks(); });

describe("muting the wake-ups of a group no longer held here", () => {
  it.each([
    ["a private group, left", "mesh", "left"],
    ["a private group I was removed from, then deleted", "mesh", "removed"],
    ["a community, left", "community", "left"],
  ] as const)("%s: nothing is saved, and joined again it is not muted", async (_, profile, end) => {
    let node = await started();
    await node.setWakeSubscription({ subscription: subscription() });
    const { groupId } = await node.createGroup({ name: "Plaza", profile });
    if (end === "left") await node.leaveGroup({ groupId });
    else {
      await node["groups"]["sessions"].get(groupId)!.markRemoved();
      await node.forgetGroup({ groupId });
    }
    expect(node["groups"].holds(groupId)).toBe(false);

    // The page's mute toggle, a moment late.
    await node.setWakeMuted({ linkId: `group:${groupId}`, muted: true });
    expect(await mutedOnDisk()).toBeUndefined();
    expect(shownMuted(node, groupId, profile)).toBe(false);

    node = await restarted(node);
    expect(shownMuted(node, groupId, profile)).toBe(false);
    // Joined again: a private group's member gets a token (a community's never does).
    if (profile === "mesh") expect((await edgeTo(node, groupId))?.k).toBeTruthy();
    expect(await mutedOnDisk()).toBeUndefined();
  });

  it("a group held here is still muted, kept after a restart, and unmuted again", async () => {
    let node = await started();
    await node.setWakeSubscription({ subscription: subscription() });
    const { groupId } = await node.createGroup({ name: "Plaza", profile: "mesh" });
    await node.setWakeMuted({ linkId: `group:${groupId}`, muted: true });
    expect(await mutedOnDisk()).toEqual([groupId]);
    node = await restarted(node);
    expect(shownMuted(node, groupId, "mesh")).toBe(true);
    expect(await edgeTo(node, groupId)).toBeNull();
    await node.setWakeMuted({ linkId: `group:${groupId}`, muted: false });
    expect(await mutedOnDisk()).toBeUndefined();
  });

  it("an unmute of a group no longer held clears the mute left over for it", async () => {
    const node = await started();
    node["settings"] = { ...node["settings"], wakeMutedGroups: ["gone"] };
    await db.putSettings(node["settings"]);
    await node.setWakeMuted({ linkId: "group:gone", muted: false });
    expect(await mutedOnDisk()).toBeUndefined();
    expect(shownMuted(node, "gone", "mesh")).toBe(false);
  });

  it("a mute an older version saved for a group no longer held goes at start; a held group's stays", async () => {
    let node = await started();
    await node.setWakeSubscription({ subscription: subscription() });
    const { groupId } = await node.createGroup({ name: "Plaza", profile: "mesh" });
    await node.setWakeMuted({ linkId: `group:${groupId}`, muted: true });
    await servers.splice(0, 1)[0]!.node.shutdown();
    // What an older version kept: the mute of a group left before it was asked.
    await db.putSettings({ ...await db.getSettings(), wakeMutedGroups: ["gone", groupId] } as never);
    node = await started();
    expect(await mutedOnDisk()).toEqual([groupId]);
    expect(node["settings"].wakeMutedGroups).toEqual([groupId]);
    expect(shownMuted(node, "gone", "mesh")).toBe(false);
    expect((await edgeTo(node, "gone"))?.k).toBeTruthy();
  });
});

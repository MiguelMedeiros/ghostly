import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { createLink, createRelayPayload, decodeInviteCode, encodeInviteCode, identityFromSeedB64, isEmptyLinkPacket, parseLinkRecords, parseRelayPayload, fromBase64Url, type SignedPacket } from "@ghostly/core";
import { GhostlyNode, SPARE_INVITE_MIN_AGE_MS } from "../src/engine/node";
import { db } from "../src/engine/db";

// covers: chat.paired.pair-timing, chat.paired.progress

/**
 * The side that made an invite holds it, and says so to the engine (`ensureLink` with `inviteCode`): the
 * engine then knows who invited whom for the pairing's progress, and warms the contact's key on the
 * network with an empty packet, so their first packet lands as a newer one under a known key.
 */

const packets = new Map<string, SignedPacket>();
const publishes: string[] = [];
const transport = {
  publish: async (identity: Parameters<typeof createRelayPayload>[0], records: Parameters<typeof createRelayPayload>[1]) => {
    publishes.push(identity.pubKeyZ32);
    packets.set(identity.pubKeyZ32, parseRelayPayload(identity.pubKeyZ32, createRelayPayload(identity, records)));
  },
  resolve: async (key: string) => packets.get(key) ?? null,
  describe: () => ({ protocol: "signed packet fixture", relays: [] }),
};
const make = () => new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false, nativeTransports: {} });

afterEach(async () => { packets.clear(); publishes.length = 0; for (const link of await db.getLinks()) await db.deleteLink(link.id); });

it("the inviter warms the contact's key with an empty packet, and is the inviter in the pairing's progress", async () => {
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  vi.stubGlobal("RTCPeerConnection", undefined);
  const node = make();
  const invitation = createLink();
  const inviteCode = encodeInviteCode({ ...invitation.invite, profile: "paired-chat/1" });
  try {
    await node.start();
    const { linkId } = await node.ensureLink({ ...invitation.mine, profile: "paired-chat/1", inviteCode });
    const contact = identityFromSeedB64(invitation.invite.seedB64);
    await vi.waitFor(() => expect(publishes).toContain(contact.pubKeyZ32));
    // What was put under the contact's key says nothing, and has no message record: nobody's own packet.
    const warm = parseLinkRecords(packets.get(contact.pubKeyZ32)!, fromBase64Url(invitation.invite.encKeyB64));
    expect(warm).toMatchObject({ services: null, latestTimestamp: 0, peerAck: 0, callSignal: null, rtcSignal: null, rawRecordNames: ["_ts"] });
    expect(isEmptyLinkPacket(warm)).toBe(true);
    // The inviter's own packet is a real one, and the empty one under the contact's key is not the contact.
    await vi.waitFor(() => expect(publishes).toContain(identityFromSeedB64(invitation.mine.seedB64).pubKeyZ32));
    const view = () => node.getState().links.find(l => l.id === linkId)!;
    await vi.waitFor(() => expect(view().pairingProgress?.stage).toBe("waiting"));
    expect(view().pairingProgress).toMatchObject({ role: "inviter", attempt: 1 });
    expect(view().pairingProgress?.peerSeen).toBeUndefined();
    expect(view().peerOnline).toBe(false);
    expect(view().peerLastSeenAt).toBe(0);
    // Asked again for the same link, the engine keeps it as it is.
    expect((await node.ensureLink({ ...invitation.mine, profile: "paired-chat/1", inviteCode })).linkId).toBe(linkId);
  } finally { await node.shutdown(); vi.unstubAllGlobals(); }
}, 20_000);

it("the side that joined is the joiner, and warms nothing", async () => {
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  vi.stubGlobal("RTCPeerConnection", undefined);
  const node = make();
  const invitation = createLink();
  try {
    await node.start();
    const { linkId } = await node.ensureLink({ ...invitation.invite, profile: "paired-chat/1" });
    const view = () => node.getState().links.find(l => l.id === linkId)!;
    await vi.waitFor(() => expect(view().pairingProgress).toMatchObject({ role: "joiner", stage: "resolving", attempt: 1 }));
    await vi.waitFor(() => expect(publishes).toContain(identityFromSeedB64(invitation.invite.seedB64).pubKeyZ32));
    expect(publishes).not.toContain(identityFromSeedB64(invitation.mine.seedB64).pubKeyZ32);
  } finally { await node.shutdown(); vi.unstubAllGlobals(); }
}, 20_000);

it("keeps a spare invite warmed, hands it out, and makes the next one", async () => {
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  vi.stubGlobal("RTCPeerConnection", undefined);
  const node = make();
  try {
    await node.start();
    // Two keys warmed at start: the spare's own side and the contact's.
    await vi.waitFor(() => expect(publishes).toHaveLength(2));
    // Taken too soon, the spare is left to settle and fresh keys go out instead; a moment later it is the one.
    const early = node.takeInvite();
    expect(publishes.slice(0, 2)).not.toContain(identityFromSeedB64(early.mine.seedB64).pubKeyZ32);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + SPARE_INVITE_MIN_AGE_MS });
    const taken = node.takeInvite();
    const mine = identityFromSeedB64(taken.mine.seedB64).pubKeyZ32;
    const contact = identityFromSeedB64(decodeInviteCode(taken.inviteCode)!.seedB64).pubKeyZ32;
    expect(publishes.slice(0, 2).sort()).toEqual([mine, contact].sort());
    // The next spare is warmed the moment this one is taken…
    await vi.waitFor(() => expect(publishes).toHaveLength(4));
    expect(publishes.slice(2)).not.toContain(mine);
    // …and the chat made from the taken one publishes its real packet, without warming the contact's key again.
    const { linkId } = await node.ensureLink({ ...taken.mine, inviteCode: taken.inviteCode });
    await vi.waitFor(() => expect(publishes.filter(k => k === mine)).toHaveLength(2));
    expect(publishes.filter(k => k === contact)).toHaveLength(1);
    const view = () => node.getState().links.find(l => l.id === linkId)!;
    await vi.waitFor(() => expect(view().pairingProgress).toMatchObject({ role: "inviter", stage: "waiting" }));
    // A ghostly1 invite (WISP 801), and this side answers with the participation key the code names.
    expect(taken.inviteCode).toMatch(/^ghostly1p/);
    expect(view().participationKey).toBe(decodeInviteCode(taken.inviteCode)!.peerParticipationKeyZ32);
    // A second take is another pair, not the same keys again.
    expect(node.takeInvite().inviteCode).not.toBe(taken.inviteCode);
  } finally { vi.useRealTimers(); await node.shutdown(); vi.unstubAllGlobals(); }
}, 20_000);

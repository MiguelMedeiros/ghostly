import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { createChatInvite, createLink, createRelayPayload, encodeInviteCode, ownInviteRefusal, parseRelayPayload, type SignedPacket } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";

// covers: invite.own

/**
 * The engine refuses to join a profile's own invite (WISP 801 Q9), whatever client asks: the join would
 * be a second link, the joiner's side of one this profile already waits on. The inviter's own side,
 * which comes with its code or its participation seed, is never a join.
 */

const packets = new Map<string, SignedPacket>();
const transport = {
  publish: async (identity: Parameters<typeof createRelayPayload>[0], records: Parameters<typeof createRelayPayload>[1]) => {
    packets.set(identity.pubKeyZ32, parseRelayPayload(identity.pubKeyZ32, createRelayPayload(identity, records)));
  },
  resolve: async (key: string) => packets.get(key) ?? null,
  describe: () => ({ protocol: "signed packet fixture", relays: [] }),
};
const make = () => new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false, nativeTransports: {} });

afterEach(async () => { packets.clear(); for (const link of await db.getLinks()) await db.deleteLink(link.id); });

it("refuses to join its own invite, by ensureLink and by joinLink, and names the chat that owns it", async () => {
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  vi.stubGlobal("RTCPeerConnection", undefined);
  const node = make();
  const profile = "paired-chat/1" as const;
  try {
    await node.start();
    const { mine, invite, inviteCode } = createChatInvite();
    const { linkId } = await node.ensureLink({ ...mine, inviteCode });
    // The joiner's side of the same invite, as the UI would ask for it, and as another client would.
    const refusal = await node.ensureLink({ ...invite }).then(() => null, (error: unknown) => error);
    expect(ownInviteRefusal(refusal)).toEqual({ linkId });
    expect((refusal as Error).message).toContain("This is your own invite");
    const byCode = await node.joinLink({ inviteCode }).then(() => null, (error: unknown) => error);
    expect(ownInviteRefusal(byCode)).toEqual({ linkId });
    expect(node.getState().links).toHaveLength(1);

    // A chat made before ghostly1 keeps the contact's key too: its older code is refused the same way.
    const older = createLink();
    const olderId = (await node.ensureLink({ ...older.mine, profile, inviteCode: encodeInviteCode({ ...older.invite, profile }) })).linkId;
    const olderRefusal = await node.joinLink({ inviteCode: encodeInviteCode({ ...older.invite, profile }) }).then(() => null, (error: unknown) => error);
    expect(ownInviteRefusal(olderRefusal)).toEqual({ linkId: olderId });

    // The inviter's own side, asked for again without its code (the code is forgotten once paired), is still its link.
    expect((await node.ensureLink({ ...mine })).linkId).toBe(linkId);
    // Someone else's invite joins as ever.
    const theirs = createChatInvite();
    const joined = await node.ensureLink({ ...theirs.invite });
    expect(node.getState().links.find((link) => link.id === joined.linkId)?.pairingProgress?.role).toBe("joiner");
    expect(node.getState().links).toHaveLength(3);
  } finally { await node.shutdown(); vi.unstubAllGlobals(); }
}, 20_000);

it("the spare invite, not yet a chat, is this profile's too", async () => {
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  vi.stubGlobal("RTCPeerConnection", undefined);
  const node = make();
  try {
    await node.start();
    const spare = (node as unknown as { spare: { inviteCode: string } | null }).spare;
    expect(spare).not.toBeNull();
    const refusal = await node.joinLink({ inviteCode: spare!.inviteCode }).then(() => null, (error: unknown) => error);
    expect(ownInviteRefusal(refusal)).toEqual({ linkId: null });
    expect(node.getState().links).toHaveLength(0);
  } finally { await node.shutdown(); vi.unstubAllGlobals(); }
}, 20_000);

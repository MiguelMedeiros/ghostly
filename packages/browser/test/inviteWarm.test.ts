import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { createLink, createRelayPayload, decodeInviteCode, encodeInviteCode, identityFromSeedB64, isEmptyLinkPacket, parseLinkRecords, parseRelayPayload, fromBase64Url, type SignedPacket } from "@ghostly/core";
import { GhostlyNode, SPARE_INVITE_MIN_AGE_MS, SPARE_INVITE_WARM_AFTER_TAKE_MS, STARTUP_QUIET_MS, WARM_DATED_BACK_MS } from "../src/engine/node";
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

it("dates the warm packet a day back, so the contact's first packet is the later one whatever its clock says", async () => {
  // Dated by the inviter's clock, the empty packet was later than the first packets of a contact whose clock runs
  // behind: the relays and the DHT kept it in their place, and a joiner two minutes behind stayed unseen for two minutes.
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  vi.stubGlobal("RTCPeerConnection", undefined);
  const payloads = new Map<string, SignedPacket>();
  const dated = { ...transport, publishPayload: async (key: string, payload: Uint8Array) => { publishes.push(key); payloads.set(key, parseRelayPayload(key, payload)); } };
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport: dated, automaticWallets: false, nativeTransports: {} });
  const invitation = createLink();
  const inviteCode = encodeInviteCode({ ...invitation.invite, profile: "paired-chat/1" });
  try {
    await node.start();
    await node.ensureLink({ ...invitation.mine, profile: "paired-chat/1", inviteCode });
    const contact = identityFromSeedB64(invitation.invite.seedB64);
    await vi.waitFor(() => expect(payloads.has(contact.pubKeyZ32)).toBe(true));
    const warm = payloads.get(contact.pubKeyZ32)!;
    expect(isEmptyLinkPacket(parseLinkRecords(warm, fromBase64Url(invitation.invite.encKeyB64)))).toBe(true);
    expect(Number(warm.timestampMicros / 1000n)).toBeLessThanOrEqual(Date.now() - WARM_DATED_BACK_MS);
    expect(Number(warm.timestampMicros / 1000n)).toBeGreaterThan(Date.now() - WARM_DATED_BACK_MS - 60_000);
    // A contact whose clock is an hour behind: its first packet is still dated after the warm one.
    expect(BigInt(Date.now() - 60 * 60_000) * 1000n).toBeGreaterThan(warm.timestampMicros);
    // The inviter's own packet goes out as before, dated by its clock.
    await vi.waitFor(() => expect(packets.has(identityFromSeedB64(invitation.mine.seedB64).pubKeyZ32)).toBe(true));
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
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  try {
    await node.start();
    // Two keys warmed a while after the start (out of the links' first packets, bug hunt r7a): the spare's own side and
    // the contact's.
    await vi.advanceTimersByTimeAsync(STARTUP_QUIET_MS - 1_000);
    expect(publishes, "nothing in the start's burst").toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(publishes).toHaveLength(2));
    vi.useRealTimers();
    // Taken too soon, the spare is left to settle and fresh keys go out instead; a moment later it is the one.
    const early = node.takeInvite();
    expect(publishes.slice(0, 2)).not.toContain(identityFromSeedB64(early.mine.seedB64).pubKeyZ32);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: Date.now() + SPARE_INVITE_MIN_AGE_MS });
    const taken = node.takeInvite();
    const mine = identityFromSeedB64(taken.mine.seedB64).pubKeyZ32;
    const contact = identityFromSeedB64(decodeInviteCode(taken.inviteCode)!.seedB64).pubKeyZ32;
    expect(publishes.slice(0, 2).sort()).toEqual([mine, contact].sort());
    // The next spare is made the moment this one is taken, and warmed a while after: not while its chat pairs…
    vi.advanceTimersByTime(SPARE_INVITE_WARM_AFTER_TAKE_MS - 1);
    expect(publishes).toHaveLength(2);
    // …and, not warmed yet, it is fresh keys like any others: handed out, and the one after it warmed later still.
    const next = node.takeInvite();
    expect(next.inviteCode).not.toBe(taken.inviteCode);
    vi.advanceTimersByTime(SPARE_INVITE_WARM_AFTER_TAKE_MS - 1);
    expect(publishes).toHaveLength(2);
    vi.advanceTimersByTime(1);
    const now = Date.now();
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date"], now });
    await vi.waitFor(() => expect(publishes).toHaveLength(4));
    expect(publishes.slice(2)).not.toContain(identityFromSeedB64(next.mine.seedB64).pubKeyZ32);
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

it("an app open for an hour hands out a warmed invite, and warms no spare too old to hand out", async () => {
  // The spare was warmed again every 4 min for good, but handed out only while under 15 min old: past that every warm-up
  // went to keys nobody would use, and the next invite went out on cold keys.
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  vi.stubGlobal("RTCPeerConnection", undefined);
  const puts: { key: string; at: number }[] = [];
  const timed = { ...transport, publish: async (...args: Parameters<typeof transport.publish>) => { puts.push({ key: args[0].pubKeyZ32, at: Date.now() }); await transport.publish(...args); } };
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport: timed, automaticWallets: false, nativeTransports: {} });
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  try {
    await node.start();
    for (let i = 0; i < 60; i++) await vi.advanceTimersByTimeAsync(60_000);
    // Not in the seconds a new spare settles (`SPARE_INVITE_MIN_AGE_MS`), which fall on whole quarters of an hour here.
    await vi.advanceTimersByTimeAsync(30_000);
    const firstPut = new Map<string, number>();
    for (const { key, at } of puts) if (!firstPut.has(key)) firstPut.set(key, at);
    expect(puts.filter(({ key, at }) => at - firstPut.get(key)! >= 15 * 60_000), "warm-ups of a spare past its age").toEqual([]);
    // The person makes an invite now: both its keys were warmed a moment ago.
    const taken = node.takeInvite();
    const mine = identityFromSeedB64(taken.mine.seedB64).pubKeyZ32, contact = identityFromSeedB64(decodeInviteCode(taken.inviteCode)!.seedB64).pubKeyZ32;
    const warmedLately = new Set(puts.filter(p => Date.now() - p.at <= 4 * 60_000).map(p => p.key));
    expect([mine, contact].filter(k => warmedLately.has(k)), "the invite handed out is a warmed one").toEqual([mine, contact]);
  } finally { vi.useRealTimers(); await node.shutdown(); vi.unstubAllGlobals(); }
}, 60_000);

it("rotates the spare at the end of its 15 min though the last timer fires a moment early by the clock", async () => {
  // Node times a timer from the loop's cached clock, so one set right after the warm's signing fires a few ms before its
  // age by `Date.now()`: the engine took the spare for young, warmed the keys it was about to drop once more, and set
  // the next timer below 0 (a TimeoutNegativeWarning in every daemon's log).
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  vi.stubGlobal("RTCPeerConnection", undefined);
  const puts: string[] = [];
  let signing = 0;
  // Each put's signing takes the clock 2 ms on, until the loop turns.
  const slow = { ...transport, publish: async (...args: Parameters<typeof transport.publish>) => { signing = 2; queueMicrotask(() => { signing = 0; }); puts.push(args[0].pubKeyZ32); await transport.publish(...args); } };
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport: slow, automaticWallets: false, nativeTransports: {} });
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const loopNow = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => loopNow() + signing);
  try {
    await node.start();
    for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(60_000);
    const perKey = new Map<string, number>();
    for (const key of puts) perKey.set(key, (perKey.get(key) ?? 0) + 1);
    // Warmed at 0, 4, 8 and 12 min of its age, then dropped: never a fifth time.
    expect(perKey.size, "spares made").toBeGreaterThanOrEqual(4);
    expect([...perKey.values()].filter(n => n > 4), "keys warmed past their last 4 min").toEqual([]);
  } finally { vi.useRealTimers(); vi.restoreAllMocks(); await node.shutdown(); vi.unstubAllGlobals(); }
}, 60_000);

import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { createLink, createRelayPayload, parseRelayPayload, type SignedPacket } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";

// covers: chat.paired.pair, chat.paired.join-notice

/**
 * A chat still being added is the same chat to a second ensureLink: the app may ask again (a sync, the
 * automatic "joined" message) while the first one is still saving it. The second waits for it and gets the
 * same id, with the chat started: never a second chat, never "You are offline" for that moment.
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

afterEach(async () => { vi.restoreAllMocks(); packets.clear(); for (const link of await db.getLinks()) await db.deleteLink(link.id); });

it("a second ensureLink while the chat is still being added waits for it: the same id, started, and a send goes", async () => {
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  vi.stubGlobal("RTCPeerConnection", undefined);
  const node = make();
  const invitation = createLink();
  const params = { ...invitation.invite, profile: "paired-chat/1" as const };
  try {
    await node.start();
    // The first one's save is slow (a busy IndexedDB): the second call and a send land in that window.
    let saved!: () => void;
    const putLink = db.putLink.bind(db);
    vi.spyOn(db, "putLink").mockImplementationOnce(async (link) => { await new Promise<void>((resolve) => (saved = resolve)); return putLink(link); });
    const first = node.ensureLink(params);
    const second = node.ensureLink(params).then(async ({ linkId }) => ({ linkId, sent: await node.sendMessage({ linkId, text: "👋 joined" }) }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    saved();
    const [{ linkId }, again] = await Promise.all([first, second]);
    expect(again.linkId).toBe(linkId);
    expect(again.sent.error).not.toBe("You are offline");
    expect(node.getState().links.filter((l) => l.id === linkId)).toHaveLength(1);
    expect((await db.getLinks()).map((l) => l.id)).toEqual([linkId]);
  } finally { await node.shutdown(); vi.unstubAllGlobals(); }
}, 20_000);

// The chat is in the state while it is saved, so the page may send by that id without asking ensureLink first: a
// message typed right after a reload, as the chat is added, came back with "You are offline" (invite-link.spec.ts).
it("a send by the id of a chat still being added waits for it to start, rather than say it is offline", async () => {
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  vi.stubGlobal("RTCPeerConnection", undefined);
  const node = make();
  const invitation = createLink();
  const params = { ...invitation.invite, profile: "paired-chat/1" as const };
  try {
    await node.start();
    let saved!: () => void;
    const putLink = db.putLink.bind(db);
    vi.spyOn(db, "putLink").mockImplementationOnce(async (link) => { await new Promise<void>((resolve) => (saved = resolve)); return putLink(link); });
    const first = node.ensureLink(params);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const linkId = node.getState().links[0]?.id;
    expect(linkId).toBeTruthy();
    const sent = node.sendMessage({ linkId: linkId!, text: "came in through the link" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    saved();
    expect((await first).linkId).toBe(linkId);
    expect((await sent).error).not.toBe("You are offline");
  } finally { await node.shutdown(); vi.unstubAllGlobals(); }
}, 20_000);

// The same window for what else the page sends by a chat's id: a file pasted (or a voice message) in the first second
// after opening the app, a forward to that chat, a payment. Each waits for the chat to start, as a text does.
it("a file sent to a chat still being added waits for it to start, rather than fail as offline", async () => {
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  vi.stubGlobal("RTCPeerConnection", undefined);
  const node = make();
  const invitation = createLink();
  const params = { ...invitation.invite, profile: "paired-chat/1" as const };
  try {
    await node.start();
    let saved!: () => void;
    const putLink = db.putLink.bind(db);
    vi.spyOn(db, "putLink").mockImplementationOnce(async (link) => { await new Promise<void>((resolve) => (saved = resolve)); return putLink(link); });
    const first = node.ensureLink(params);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const linkId = node.getState().links[0]?.id;
    expect(linkId).toBeTruthy();
    const file = { id: `${linkId}-out-pastedfile01`, name: "pasted.png", size: 1234, mime: "image/png" };
    const sent = node.sendFile({ linkId: linkId!, file, timestamp: Date.now() }).then(() => null, (error: Error) => error.message);
    await new Promise((resolve) => setTimeout(resolve, 50));
    saved();
    expect((await first).linkId).toBe(linkId);
    expect(await sent).not.toBe("You are offline");
    expect(node.getState().transfers?.[file.id]?.error).not.toBe("You are offline");
  } finally { await node.shutdown(); vi.unstubAllGlobals(); }
}, 20_000);

it("a forward to a chat still being added waits for it to start, rather than say it is offline", async () => {
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  vi.stubGlobal("RTCPeerConnection", undefined);
  const node = make();
  const from = { ...createLink().invite, profile: "paired-chat/1" as const };
  const to = { ...createLink().invite, profile: "paired-chat/1" as const };
  try {
    await node.start();
    const { linkId: source } = await node.ensureLink(from);
    const written = await node.sendMessage({ linkId: source, text: "pass this on" });
    expect(written.messageId).toBeTruthy();
    let saved!: () => void;
    const putLink = db.putLink.bind(db);
    vi.spyOn(db, "putLink").mockImplementationOnce(async (link) => { await new Promise<void>((resolve) => (saved = resolve)); return putLink(link); });
    const adding = node.ensureLink(to);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const target = node.getState().links.find((l) => l.id !== source)?.id;
    expect(target).toBeTruthy();
    const forwarded = node.forwardMessages({ linkId: source, messageIds: [written.messageId!], to: [target!] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    saved();
    expect((await adding).linkId).toBe(target);
    const [result] = (await forwarded).results;
    expect(result.error).not.toBe("You are offline");
    expect(result.messageIds).toHaveLength(1);
  } finally { await node.shutdown(); vi.unstubAllGlobals(); }
}, 20_000);

it("a creation that fails fails the call waiting on it too, and leaves no chat behind", async () => {
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  vi.stubGlobal("RTCPeerConnection", undefined);
  const node = make();
  const invitation = createLink();
  const params = { ...invitation.invite, profile: "paired-chat/1" as const };
  try {
    await node.start();
    let failed!: () => void;
    vi.spyOn(db, "putLink").mockImplementationOnce(async () => { await new Promise<void>((resolve) => (failed = resolve)); throw new Error("disk full"); });
    const first = node.ensureLink(params);
    const second = node.ensureLink(params);
    await new Promise((resolve) => setTimeout(resolve, 50));
    failed();
    await expect(first).rejects.toThrow("disk full");
    await expect(second).rejects.toThrow("disk full");
    expect(node.getState().links).toHaveLength(0);
    // Asked again once it failed, the chat is made afresh.
    const { linkId } = await node.ensureLink(params);
    expect((await db.getLinks()).map((l) => l.id)).toEqual([linkId]);
  } finally { await node.shutdown(); vi.unstubAllGlobals(); }
}, 20_000);

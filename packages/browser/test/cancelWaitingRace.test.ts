import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { createIdentity, createLink, createRelayPayload, DhtDelivery, parseRelayPayload, RelayTransport } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
// covers: chat.waiting, chat.paired.delete-message

/*
 * A DHT-only chat whose relays refused a text: it waits (`waiting`), with Cancel sending on its ⋮. The relays take
 * requests again and the outbox's retry of it begins: it reads the row, marks it `sending`, and hands what it read to
 * the link. A Cancel sending (or a Delete for everyone) fired anywhere in that retry deleted the row here and the
 * text went all the same: gone here, read there. Now it either never goes, or, once it was handed to the link, its
 * removal goes after it. Never gone here and kept by the contact.
 */

/** Two relays sharing one store of packets: each takes PUTs or refuses them; reads always answer. `onPut` runs as a PUT is taken. */
function fakeRelays() {
  const packets = new Map<string, Uint8Array>();
  let refusing = false;
  const hooks: { onPut?: () => void } = {};
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = new URL(String(input)).pathname.slice(1);
    if (init?.method !== "PUT") return packets.has(key) ? new Response(packets.get(key)! as BodyInit) : new Response(null, { status: 404 });
    if (refusing) return new Response(null, { status: 403 });
    hooks.onPut?.();
    packets.set(key, new Uint8Array(init.body as Uint8Array));
    return new Response(null, { status: 204 });
  }) as typeof globalThis.fetch;
  return { packets, fetch, hooks, refuse: (on: boolean) => { refusing = on; } };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function chat() {
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  vi.stubGlobal("RTCPeerConnection", undefined);
  const relays = fakeRelays();
  const transport = new RelayTransport({ relays: ["https://a.test", "https://b.test"], fetch: relays.fetch, timeoutMs: 200, requestsPerMinute: Infinity, log: () => {} });
  const native = vi.fn();
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: vi.fn() },
    { transport, automaticWallets: false, nativeTransports: { "iroh/1": native, "hyperdht/1": native } });
  const invitation = createLink();
  await node.start();
  const { linkId } = await node.ensureLink({ ...invitation.mine, profile: "paired-chat/1", deliveryMode: "dht" });
  node.setActiveLink({ linkId });
  cleanup.push(async () => { await node.shutdown(); await db.deleteLink(linkId); });
  const received: string[] = [];
  /** The contact, reading the relays' store directly: it gets what a relay took, and nothing else. */
  const contact = new DhtDelivery({ params: invitation.invite, mode: "dht", credentials: { seedB64: createIdentity().seedB64 }, pollMs: 100,
    transport: {
      publish: async (identity, records) => { relays.packets.set(identity.pubKeyZ32, createRelayPayload(identity, records)); },
      resolve: async (key) => relays.packets.has(key) ? parseRelayPayload(key, relays.packets.get(key)!) : null,
      describe: () => ({ protocol: "fixture", relays: [] }),
    },
    save: async () => {}, pin: async () => {}, message: async (m) => { received.push(m.text); }, receipt: async () => {}, changed: () => {} });
  cleanup.push(() => contact.stop());
  const row = async (id: string) => (await db.getMessages(linkId)).find((m) => m.id === id);
  const send = async (text: string, timestamp: number) => {
    const { error, messageId } = await node.sendMessage({ linkId, text, timestamp });
    expect(error).toBeNull();
    return messageId!;
  };
  const got = (text: string) => received.includes(text);
  const deleted = async (id: string) => !!(await db.getLinks()).find((l) => l.id === linkId)?.deletedIds?.includes(id);
  return { node, linkId, relays, contact, received, row, send, got, deleted };
}

/** Each text written after the cancelled one, and the contact reading it: what was going to go has gone by then. */
async function settled(t: Awaited<ReturnType<typeof chat>>, text: string) {
  await vi.waitFor(() => expect(t.received).toContain(text), { timeout: 30_000, interval: 200 });
}

/** A waiting text and one behind it; `fire` runs at the moment named, on the outbox's retry of the first once the relays take requests. */
async function race(when: "before-mark" | "after-mark" | "handed", fire: (t: Awaited<ReturnType<typeof chat>>, id: string) => void) {
  const t = await chat();
  t.relays.refuse(true);
  const now = Date.now();
  const first = await t.send("cancel me", now);
  expect((await t.row(first))?.delivery).toBe("waiting");
  await t.send("after it", now + 1);
  let fired = false, marked = false;
  const original = db.updateDelivery.bind(db);
  vi.spyOn(db, "updateDelivery").mockImplementation(async (linkId, id, delivery, ...rest) => {
    if (fired || id !== first || delivery !== "sending") return original(linkId, id, delivery, ...rest);
    if (when === "before-mark") { fired = true; fire(t, first); return original(linkId, id, delivery, ...rest); }
    await original(linkId, id, delivery, ...rest);
    if (when === "after-mark") { fired = true; fire(t, first); } else marked = true;
  });
  // The first PUT once its row says `sending`: the text is in the link's hands, on its way to the relay.
  t.relays.hooks.onPut = () => { if (when === "handed" && marked && !fired) { fired = true; fire(t, first); } };
  t.relays.refuse(false);
  await t.contact.start();
  await settled(t, "after it");
  expect(fired).toBe(true);
  return { t, first };
}

for (const when of ["before-mark", "after-mark"] as const) {
  it(`Cancel sending ${when === "before-mark" ? "as the retry marks the waiting text sending" : "just after the retry marked it sending"}: the contact never gets it`, async () => {
    const { t, first } = await race(when, (c, id) => c.node.deleteMessage({ linkId: c.linkId, messageId: id }));
    // A little longer: a send that was going to go has gone by now.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(t.got("cancel me")).toBe(false);
    expect(await t.row(first)).toBeUndefined();
    expect(await t.deleted(first)).toBe(true);
    expect(t.node.removalPending({ linkId: t.linkId, messageId: first })).toBe(false);
  }, 60_000);
}

it("Cancel sending once the retry handed the text to the link: it may be out, so it is deleted for everyone", async () => {
  const { t, first } = await race("handed", (c, id) => c.node.deleteMessage({ linkId: c.linkId, messageId: id }));
  // The relay took it: the contact has it. Its removal is on its way (WISP 400: said once the chat is live, as any
  // Delete for everyone's), where it used to be gone here with nothing left to take it back.
  expect(t.got("cancel me")).toBe(true);
  await vi.waitFor(() => expect(t.node.removalPending({ linkId: t.linkId, messageId: first })).toBe(true), { timeout: 5_000, interval: 100 });
  expect(await t.row(first)).toBeUndefined();
  expect(await t.deleted(first)).toBe(true);
}, 60_000);

it("Delete for everyone on a waiting text, as the retry marks it sending: never sent, or its removal goes after it", async () => {
  const { t, first } = await race("before-mark", (c, id) => { void c.node.removeMessage({ linkId: c.linkId, messageId: id }); });
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  // Either the retry was stopped before the hand-off, or it went and its removal is on its way: never kept unknown.
  const pending = t.node.removalPending({ linkId: t.linkId, messageId: first });
  expect(pending).toBe(t.got("cancel me"));
  expect(await t.row(first)).toBeUndefined();
}, 60_000);

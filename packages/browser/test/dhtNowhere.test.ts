import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { createIdentity, createLink, createRelayPayload, DhtDelivery, parseRelayPayload, RelayTransport } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { NotSent } from "../src/engine/outbox";
import { db } from "../src/engine/db";
// covers: chat.dht.send, chat.waiting

/*
 * A contact away, the chat on the DHT, and the relays not taking what is published. A text whose publication every
 * relay refused (or was not asked, or could not be reached before the request went) never left this device: it waits
 * as `waiting` does, so its ⋮ has Cancel sending, and a cancelled one is never published once the relays take requests
 * again. One that a relay may hold (it did not answer in time) stays `queued`, as before: it may be out. The texts
 * written after it go after it, in order.
 */

type Mode = "ok" | "refuse" | "noConnection" | "timeout";
const ECONNREFUSED = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }) });

/** Two relays sharing one store of packets: each takes PUTs or not (`modes`); reads always answer. */
function fakeRelays() {
  const packets = new Map<string, Uint8Array>();
  const modes: Record<"a" | "b", Mode> = { a: "ok", b: "ok" };
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), key = url.pathname.slice(1), mode = modes[url.host.startsWith("a.") ? "a" : "b"];
    if (init?.method !== "PUT") return packets.has(key) ? new Response(packets.get(key)! as BodyInit) : new Response(null, { status: 404 });
    if (mode === "refuse") return new Response(null, { status: 403 });
    if (mode === "noConnection") throw ECONNREFUSED();
    if (mode === "timeout") return new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    packets.set(key, new Uint8Array(init.body as Uint8Array));
    return new Response(null, { status: 204 });
  }) as typeof globalThis.fetch;
  const set = (a: Mode, b: Mode = a) => { modes.a = a; modes.b = b; };
  return { packets, fetch, set };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); vi.unstubAllGlobals(); });

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
  const floor = async () => (await db.getLinks()).find((l) => l.id === linkId)?.dhtDeliveryState?.pending?.message[0];
  return { node, linkId, relays, contact, received, row, send, floor };
}

it("every relay refusing: the first text waits, cancellable, and once cancelled is never published; the next one goes", async () => {
  const { node, linkId, relays, contact, received, row, send, floor } = await chat();
  relays.set("refuse");
  const t = Date.now();
  const first = await send("the first, refused everywhere", t);
  // It was `queued` ("sent at least once, not confirmed"), with no Cancel sending, though it never left this device.
  expect((await row(first))?.delivery).toBe("waiting");
  expect((await row(first))?.deliveryError).toBe(NotSent.REASON);
  // Off the floor: nothing publishes it by itself once a relay takes requests again.
  expect(await floor()).toBeUndefined();
  const second = await send("the second", t + 1);
  expect((await row(second))?.delivery).toBe("waiting");
  // Cancel sending (the ⋮'s, on a waiting text): the chat's own delete.
  await node.deleteMessage({ linkId, messageId: first });
  relays.set("ok");
  await contact.start();
  await vi.waitFor(() => expect(received).toContain("the second"), { timeout: 30_000, interval: 200 });
  expect(received).not.toContain("the first, refused everywhere");
  expect(await row(first)).toBeUndefined();
}, 45_000);

it("every relay refusing: the texts after the first wait behind it, and go in order once the relays take them", async () => {
  const { relays, contact, received, row, send } = await chat();
  relays.set("refuse");
  const t = Date.now();
  const first = await send("one", t), second = await send("two", t + 1);
  expect([(await row(first))?.delivery, (await row(second))?.delivery]).toEqual(["waiting", "waiting"]);
  relays.set("ok");
  await contact.start();
  await vi.waitFor(() => expect([...new Set(received)]).toEqual(["one", "two"]), { timeout: 40_000, interval: 200 });
}, 50_000);

it("no relay reachable (connection refused, as Node says it): the first text waits, cancellable", async () => {
  const { relays, row, send, floor } = await chat();
  relays.set("noConnection");
  const first = await send("refused connection", Date.now());
  expect((await row(first))?.delivery).toBe("waiting");
  expect(await floor()).toBeUndefined();
});

for (const [name, a, b] of [["every relay timing out", "timeout", "timeout"], ["one relay refusing, the other timing out", "refuse", "timeout"]] as const) {
  it(`${name}: the first text may be out, so it stays queued (no Cancel sending), as before`, async () => {
    const { relays, row, send, floor } = await chat();
    // What the chat published as it opened went out: the relays are asked for this text, not left alone after failing.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    relays.set(a, b);
    const first = await send("maybe out", Date.now());
    expect((await row(first))?.delivery).toBe("queued");
    expect((await row(first))?.deliveryError).toContain("Publish failed on every relay");
    // Still the floor's: it goes again by itself.
    expect(await floor()).toBe((await row(first))?.wireId);
  });
}

it("a relay taking it: sent, as before", async () => {
  const { relays, row, send, floor } = await chat();
  relays.set("refuse", "ok");
  const first = await send("taken by one relay", Date.now());
  expect((await row(first))?.delivery).toBe("sent");
  expect(await floor()).toBe((await row(first))?.wireId);
});

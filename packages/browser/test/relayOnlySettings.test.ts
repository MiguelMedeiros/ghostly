import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { relayOnlyProblem } from "../src/shared/ice";
import { STORES, transact } from "../src/shared/idb";
import type { StoredLink } from "../src/shared/types";
// covers: settings.network.relay-only

const TURN = { urls: "turn:turn.example.org:3478", username: "u", credential: "p" };
const fixture = { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) };

const nodes: GhostlyNode[] = [];
function engine(options: ConstructorParameters<typeof GhostlyNode>[1] = {}) {
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: false, ...options });
  nodes.push(node);
  return node;
}

async function addChat(node: GhostlyNode, link: { stop: ReturnType<typeof vi.fn> } | null) {
  const row: StoredLink = { id: `chat-${crypto.randomUUID().slice(0, 8)}`, profile: "paired-chat/1", createdAt: 1, seedB64: createIdentity().seedB64,
    encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64 };
  await db.putLink(row);
  node["links"].set(row.id, { stored: row, myPubKeyZ32: "me", link: link as never, status: "online", dataLink: "open",
    presence: { online: true, lastPacketAt: 0, services: null }, lastMessageAt: 0, peerAck: 0, lastSyncAt: 0,
    poll: { polling: false, nextAt: 0, interval: 0 }, files: { receivedBytes: 0, wireIds: new Set(), incoming: new Map() } });
  return row;
}

beforeEach(async () => {
  await transact([STORES.settings, STORES.links, STORES.messages], (s) => { for (const name of [STORES.settings, STORES.links, STORES.messages]) s[name].clear(); });
});
afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown(); vi.restoreAllMocks(); });

describe("Hide my IP from contacts (relayOnly)", () => {
  it("needs a TURN server with its credential: a STUN server or a TURN server without one does not do", () => {
    expect(relayOnlyProblem([])).toBe("Add a TURN server first");
    expect(relayOnlyProblem(undefined)).toBe("Add a TURN server first");
    expect(relayOnlyProblem([{ urls: "stun:stun.example.org" }])).toBe("Add a TURN server first");
    expect(relayOnlyProblem([{ urls: "turn:turn.example.org:3478", username: "u" }])).toBe("Add a TURN server first");
    expect(relayOnlyProblem([TURN])).toBeNull();
    expect(relayOnlyProblem([{ ...TURN, urls: "stun:a.example.org, turns:turn.example.org:5349" }])).toBeNull();
  });

  it("is not turned on without a TURN server, and its TURN server is not taken away while it is on; off is not stored", async () => {
    const node = engine();
    await expect(node.updateSettings({ settings: { relayOnly: true } })).rejects.toThrow("Add a TURN server first");
    await expect(node.updateSettings({ settings: { relayOnly: "yes" as never } })).rejects.toThrow("relayOnly is on or off");
    expect(node["settings"].relayOnly).toBeUndefined();
    expect(await db.getSettings()).toEqual({});
    // A TURN server and the switch in one patch is fine.
    await node.updateSettings({ settings: { iceServers: [TURN], relayOnly: true } });
    expect(node.getState().settings.relayOnly).toBe(true);
    expect((await db.getSettings()).relayOnly).toBe(true);
    await expect(node.updateSettings({ settings: { iceServers: [] } })).rejects.toThrow("Hide my IP from contacts needs a TURN server. Turn it off first");
    expect(node["settings"].iceServers).toEqual([TURN]);
    await node.updateSettings({ settings: { relayOnly: false } });
    expect(await db.getSettings()).not.toHaveProperty("relayOnly");
    await node.updateSettings({ settings: { iceServers: [] } });
  });

  it("a chat's and a group's WebRTC go through the TURN server only while it is on, and as before while it is off", async () => {
    const node = engine();
    await node.updateSettings({ settings: { iceServers: [TURN] } });
    const off = node["contactRtcConfig"]();
    expect(off.iceTransportPolicy).toBeUndefined();
    expect(JSON.stringify(off.iceServers)).toContain("stun:stun.l.google.com");
    await node.updateSettings({ settings: { relayOnly: true } });
    expect(node["contactRtcConfig"]()).toEqual({ iceServers: [{ urls: ["turn:turn.example.org:3478"], username: "u", credential: "p" }], iceTransportPolicy: "relay" });
  });

  it("this app's own Iroh and HyperDHT are not offered to contacts while it is on (HyperDHT goes through the relay); its own devices keep them", async () => {
    const iroh = vi.fn(), hyperdht = vi.fn();
    const node = engine({ nativeTransports: { "iroh/1": iroh as never, "hyperdht/1": hyperdht as never } });
    expect(node["nativeFactories"]["iroh/1"]).toBe(iroh);
    expect(node["nativeFactories"]["hyperdht/1"]).toBe(hyperdht);
    await node.updateSettings({ settings: { iceServers: [TURN], relayOnly: true } });
    // Without a HyperDHT relay (none by default) there is no HyperDHT for contacts at all.
    expect(Object.keys(node["nativeFactories"])).toEqual([]);
    await node.updateSettings({ settings: { hyperdhtRelay: "wss://relay.example" } });
    const contacts = node["nativeFactories"];
    expect(contacts["iroh/1"]).toBeUndefined();
    expect(contacts["hyperdht/1"]).toBeDefined();
    expect(contacts["hyperdht/1"]).not.toBe(hyperdht);
    expect(node["deviceNativeFactories"]).toEqual({ "iroh/1": iroh, "hyperdht/1": hyperdht });
  });

  it("turned on or off, every chat starts over without a goodbye, so no connection made before keeps a direct path", async () => {
    const node = engine({ transport: fixture });
    const link = { stop: vi.fn(async () => {}) };
    const chat = await addChat(node, link);
    const started = vi.spyOn(node as never as { startLink: (id: string) => void }, "startLink").mockImplementation(() => {});
    await node.updateSettings({ settings: { iceServers: [TURN] } });
    expect(link.stop).not.toHaveBeenCalled();
    await node.updateSettings({ settings: { relayOnly: true } });
    expect(link.stop).toHaveBeenCalledWith(false);
    expect(started).toHaveBeenCalledWith(chat.id, []);
    // The same value again changes nothing.
    await node.updateSettings({ settings: { relayOnly: true } });
    expect(link.stop).toHaveBeenCalledOnce();
  });
});

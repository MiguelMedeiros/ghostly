import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, identityFromSeed, sign, signTurnPacket, toBase64Url, turnKeys, type PkarrTransport, type TurnNetwork } from "@ghostly/core";
import type { GhostlyNode } from "../src/engine/node";
import type { EngineServer } from "../src/engine/server";
import { createPeerServer } from "../src/devices/peer";
import { resetDeviceGates } from "../src/devices/gate";
import { closeDevicesDb, readDeviceRecord, setDeviceMirror } from "../src/devices/store";
import { createDeviceSigningKey } from "../src/devices/signingKey";
import type { DeviceRecord } from "../src/devices/state";
import { db } from "../src/engine/db";
import { STORES, databaseName, setDatabaseName, transact } from "../src/shared/idb";
import type { DeviceGateView } from "../src/devices/gate";
import { dropDevicesDatabase, putDeviceRecord } from "./helpers/deviceRecord";
import { FakeTurnNetwork } from "./helpers/turnNetwork";
// covers: devices.turn.limited

/*
 * The active device of a device set reads the turn as a condition of starting (WISP 06 § When a device checks). That
 * read is for publishing, dialling and the single-writer wallets, not for reading the profile's own chats: the engine
 * starts at once in limited mode, which publishes, dials and settles nothing, and the read's answer starts it properly,
 * keeps it limited, or stops it. Its chat list showed nothing until the read, the put and the read back were done
 * (0.8 s with relays answering in 0.25 s, 16.7 s with one of two relays hanging).
 */

const D = new Uint8Array(32).fill(0x6a);
const keys = turnKeys(D);
const phone = identityFromSeed(new Uint8Array(32).fill(0x61));
const N = 4_000;

/** A transport that answers nothing and sends nothing: the chats are never dialled here (the network switch is off). */
const quiet: PkarrTransport = {
  publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "quiet", relays: [] }),
  turnRead: async () => [], turnPut: async () => [],
};

/** The turn read held until `answer()`: a relay that is slow, or one that hangs. */
function held(network: FakeTurnNetwork): { turn: TurnNetwork; answer(): void } {
  let answer!: () => void;
  const gate = new Promise<void>((resolve) => { answer = resolve; });
  return { answer, turn: { turnRead: async (...args) => { await gate; return network.turnRead(...args); }, turnPut: network.turnPut.bind(network) } };
}

let n = 0;
const servers: EngineServer[] = [];
beforeEach(async () => {
  resetDeviceGates();
  setDeviceMirror(null);
  await closeDevicesDb();
  await dropDevicesDatabase();
  setDatabaseName(`ghostly_startcheck${++n}`);
  const stores = [STORES.settings, STORES.links, STORES.messages, STORES.services];
  await transact(stores, (s) => { for (const name of stores) s[name].clear(); });
});
afterEach(async () => { for (const server of servers.splice(0)) await server.stop().catch(() => {}); resetDeviceGates(); });

/** This device, active in slot 0 with its own record of turn `N` stored, the phone in slot 1, and one chat. */
async function activeDesktop(): Promise<{ stored: Uint8Array; chat: string }> {
  const key = await createDeviceSigningKey(databaseName(), { forceSeed: true });
  const slots = [{ key: key.publicKey, name: "Desktop" }, { key: phone.publicKey, name: "Phone" }, null, null];
  const stored = await signTurnPacket(keys, { turn: N, rev: 0, author: 0, active: 0, slots, instance: new Uint8Array(8).fill(1) }, (bytes) => key.sign(bytes));
  await putDeviceRecord({
    v: 1, profile: databaseName(), state: "active", saved: 1, turn: N, rev: 0, d: toBase64Url(D), ownSlot: 0, activeSlot: 0, signingKey: key.kind,
    deviceSet: [{ key: toBase64Url(key.publicKey), name: "Desktop" }, { key: toBase64Url(phone.publicKey), name: "Phone" }],
    turnPacket: toBase64Url(stored), takeovers: 0, earlierSets: [],
  } satisfies DeviceRecord);
  const chat = `chat-${crypto.randomUUID().slice(0, 8)}`;
  await db.putLink({ id: chat, profile: "paired-chat/1", createdAt: 1, seedB64: createIdentity().seedB64, encKeyB64: createIdentity().seedB64,
    peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64 });
  await db.putSettings({ online: false } as never);
  return { stored, chat };
}

/** The peer as the pages get it, within `ms`: undefined if it was not made by then. */
async function peerWithin(turn: TurnNetwork, ms: number): Promise<EngineServer | undefined> {
  const making = createPeerServer({ transport: quiet, automaticWallets: false }, { turn }).then((peer) => { servers.push(peer as EngineServer); return peer as EngineServer; });
  return Promise.race([making, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))]);
}

const nodeOf = (server: EngineServer): GhostlyNode => server.node;

describe("the active device's start, while its turn read is out", () => {
  it("shows the profile's chats at once, in limited mode, and starts properly when the read says it is the active one", async () => {
    const network = new FakeTurnNetwork();
    const { stored, chat } = await activeDesktop();
    network.seed(stored);
    const read = held(network);
    const server = await peerWithin(read.turn, 2_000);
    expect(server, "the engine waited for the turn read").toBeDefined();
    await server!.ready;
    const node = nodeOf(server!);
    // The chat list is loaded from this device's own store; nothing is published or dialled meanwhile.
    expect(node.getState()).toMatchObject({ groupsLoaded: true, limited: true, startCheck: true });
    expect(node.getState().links.map((link) => link.id)).toEqual([chat]);
    expect(network.puts()).toEqual([]);
    read.answer();
    await vi.waitFor(() => expect(node.limited).toBe(false));
    expect(node.getState().startCheck).toBeUndefined();
    // The read at start wrote this device's next record, as before.
    expect((await readDeviceRecord(databaseName()))?.rev).toBe(1);
  });

  it("another device took the turn while it was off: the engine stops having published nothing, and the pages start again into the gate", async () => {
    const network = new FakeTurnNetwork();
    await activeDesktop();
    const slots = [{ key: (await createDeviceSigningKey(databaseName())).publicKey, name: "Desktop" }, { key: phone.publicKey, name: "Phone" }, null, null];
    network.seed(await signTurnPacket(keys, { turn: N + 1, rev: 0, author: 1, active: 1, slots, instance: new Uint8Array(8).fill(2) }, (bytes) => sign(bytes, phone.seed)));
    const read = held(network);
    const server = await peerWithin(read.turn, 2_000);
    expect(server).toBeDefined();
    await server!.ready;
    const gates: DeviceGateView[] = [];
    server!.attach({ post: (event) => { if (event.kind === "device-gate") gates.push(event.gate); } });
    read.answer();
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    expect(gates[0]).toMatchObject({ state: "superseded", activeDevice: "Phone", reload: true });
    expect(await readDeviceRecord(databaseName())).toMatchObject({ state: "superseded", copy: "frozen", activeSlot: 1 });
    expect(network.puts()).toEqual([]);
  });

  it("no source answers: it stays in limited mode, and the pages are told the read is no longer out (they ask Try again or Start anyway)", async () => {
    const network = new FakeTurnNetwork();
    await activeDesktop();
    for (const source of network.sources) source.down = true;
    const read = held(network);
    const server = await peerWithin(read.turn, 2_000);
    expect(server).toBeDefined();
    await server!.ready;
    const node = nodeOf(server!);
    read.answer();
    await vi.waitFor(() => expect(node.getState().startCheck).toBeUndefined());
    expect(node.getState().limited).toBe(true);
    expect((await readDeviceRecord(databaseName()))?.state).toBe("active");
  });
});

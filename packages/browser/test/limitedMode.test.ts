import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, type GhostRecord, type Identity, type PkarrTransport } from "@ghostly/core";
import { GhostlyNode, LIMITED_MODE_ERROR, LIMITED_MODE_METHODS, LimitedModeError } from "../src/engine/node";
import { EngineServer } from "../src/engine/server";
import { createPeerServer } from "../src/devices/peer";
import { openDeviceGate, resetDeviceGates } from "../src/devices/gate";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import type { EngineEvent, RpcRequest, RpcResponse } from "../src/shared/rpc";
import type { StoredLink } from "../src/shared/types";
// covers: devices.turn.limited

/*
 * Limited mode (WISP 06 § When a device checks): the device could not read which device is active, and the person
 * chose "Start anyway". Until a good read "nothing is published, nothing is dialled and nothing is settled in hold
 * storage; no wallet is opened and no admin work is done". Each of those is a switch in the engine, proven here on
 * a profile that has a chat, hold storage and a public DID, with the person's own network switch on.
 */

/** A transport that records every request. Nothing leaves the process. */
function recording() {
  const calls: string[] = [];
  const transport: PkarrTransport = {
    publish: async (_identity: Identity, _records: GhostRecord[]) => { calls.push("publish"); },
    publishPayload: async () => { calls.push("publishPayload"); },
    resolve: async () => { calls.push("resolve"); return null; },
    describe: () => ({ protocol: "recording", relays: [] }),
    turnRead: async () => { calls.push("turnRead"); return []; },
    turnPut: async () => { calls.push("turnPut"); return []; },
  };
  return { calls, transport };
}

const chat = (): StoredLink => ({ id: `chat-${crypto.randomUUID().slice(0, 8)}`, profile: "paired-chat/1", createdAt: 1, seedB64: createIdentity().seedB64,
  encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64 });
const HOLD = { space: "abcdefghijklmnop", s3: { endpoint: "https://s3.invalid", region: "auto", bucket: "bucket", prefix: "", accessKeyId: "k", secretAccessKey: "s" } };

const nodes: GhostlyNode[] = [];
/** A node with spies on what limited mode must not do. Its wallets and its dialling are stubbed: what counts is whether they are asked. */
function engine(limited: boolean) {
  const { calls, transport } = recording();
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, limited, automaticWallets: false });
  nodes.push(node);
  const inner = node as unknown as Record<string, unknown> & { hold: { running: boolean; start(): void; host: { storage(): unknown } }; did: { publishNow(): Promise<void> } };
  const startWallets = vi.spyOn(inner as unknown as { startWallets(): Promise<void> }, "startWallets").mockResolvedValue();
  const openWallets = vi.spyOn(inner as unknown as { openStartedWallets(fresh: boolean): void }, "openStartedWallets").mockImplementation(() => {});
  const startLink = vi.spyOn(inner as unknown as { startLink(id: string): void }, "startLink").mockImplementation(() => {});
  const groupEntries = vi.spyOn(inner as unknown as { startGroupEntries(): void }, "startGroupEntries").mockImplementation(() => {});
  const spare = vi.spyOn(inner as unknown as { prepareSpare(ms: number): void }, "prepareSpare").mockImplementation(() => {});
  const holdStart = vi.spyOn(inner.hold, "start").mockImplementation(() => {});
  const didPublish = vi.spyOn(inner.did, "publishNow").mockResolvedValue();
  return { node, inner, calls, transport, startWallets, openWallets, startLink, groupEntries, spare, holdStart, didPublish };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

beforeEach(async () => {
  const stores = [STORES.settings, STORES.links, STORES.messages, STORES.services];
  await transact(stores, (s) => { for (const name of stores) s[name].clear(); });
});
afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown().catch(() => {}); vi.restoreAllMocks(); });

async function profile(): Promise<StoredLink> {
  const link = chat();
  await db.putLink(link);
  await db.putSettings({ online: true, holdStorage: HOLD } as never);
  return link;
}

describe("limited mode", () => {
  it("the same profile started properly dials, opens wallets and starts hold storage: what the switches below turn off", async () => {
    const link = await profile();
    const made = engine(false);
    await made.node.start();
    expect(made.node.limited).toBe(false);
    expect(made.startWallets).toHaveBeenCalledOnce();
    expect(made.openWallets).toHaveBeenCalledOnce();
    expect(made.startLink.mock.calls.map((call) => call[0])).toEqual([link.id]);
    expect(made.holdStart).toHaveBeenCalledOnce();
    expect(made.groupEntries).toHaveBeenCalledOnce();
    expect(made.inner.hold.host.storage()).not.toBeNull();
    expect(made.node.getState().limited).toBeUndefined();
  });

  it("nothing is published, nothing is dialled, nothing is settled in hold storage and no wallet is opened", async () => {
    const link = await profile();
    const made = engine(true);
    await made.node.start();
    await flush();
    expect(made.node.limited).toBe(true);
    // No wallet is opened.
    expect(made.startWallets).not.toHaveBeenCalled();
    expect(made.openWallets).not.toHaveBeenCalled();
    // Nothing is dialled: no chat link, no group entry, no spare identity warmed.
    expect(made.startLink).not.toHaveBeenCalled();
    expect(made.groupEntries).not.toHaveBeenCalled();
    expect(made.spare).not.toHaveBeenCalled();
    expect(made.node.getState().links.map((l) => [l.id, l.status])).toEqual([[link.id, "offline"]]);
    // Nothing is settled in hold storage: the hold engine does not run, and has no storage to put to or delete from.
    expect(made.holdStart).not.toHaveBeenCalled();
    expect(made.inner.hold.host.storage()).toBeNull();
    // Nothing is published, and nothing was even read: the transport saw no request.
    expect(made.calls).toEqual([]);
    // The history is there to read, and the pages are told the mode. The person's own switch is untouched.
    expect(made.node.getState()).toMatchObject({ limited: true, settings: { online: true } });
    expect((await db.getSettings()).online).toBe(true);
  });

  it("the person's network switch cannot turn it on, and what they set is kept for later", async () => {
    await profile();
    const made = engine(true);
    await made.node.start();
    await made.node.updateSettings({ settings: { online: false } });
    await made.node.updateSettings({ settings: { online: true, nick: "Ana" } });
    await flush();
    expect(made.startLink).not.toHaveBeenCalled();
    expect(made.holdStart).not.toHaveBeenCalled();
    expect(made.didPublish).not.toHaveBeenCalled();
    expect(made.calls).toEqual([]);
    expect((await db.getSettings())).toMatchObject({ online: true, nick: "Ana" });
  });

  it("the transport itself refuses a publish: the one switch no code path can forget", async () => {
    await profile();
    const made = engine(true);
    await made.node.start();
    const transport = made.inner.transport as PkarrTransport;
    await expect(transport.publish(createIdentity(), [{ label: "_x", value: "y" }])).rejects.toThrow(LimitedModeError);
    await expect(transport.publishPayload!("key", new Uint8Array(80))).rejects.toThrow(LimitedModeError);
    // A group's records go through the same one.
    await expect((made.inner.groupTransport as PkarrTransport).publish(createIdentity(), [])).rejects.toThrow(LimitedModeError);
    expect(made.calls).toEqual([]);
  });

  it("a message cannot be sent to the network, and joining, calling and new chats are refused by the engine as when offline", async () => {
    const link = await profile();
    const made = engine(true);
    await made.node.start();
    expect(await made.node.sendMessage({ linkId: link.id, text: "hello" })).toMatchObject({ error: "You are offline" });
    await expect(made.node.connect({ linkId: link.id })).rejects.toThrow("offline");
    expect(made.calls).toEqual([]);
  });

  it("the first good read leaves it: the wallets start, every chat is dialled, hold storage runs, and publishing works again", async () => {
    const link = await profile();
    const made = engine(true);
    await made.node.start();
    await made.node.leaveLimited();
    expect(made.node.limited).toBe(false);
    expect(made.startWallets).toHaveBeenCalledOnce();
    expect(made.openWallets).toHaveBeenCalledOnce();
    expect(made.startLink.mock.calls.map((call) => call[0])).toEqual([link.id]);
    expect(made.holdStart).toHaveBeenCalledOnce();
    expect(made.groupEntries).toHaveBeenCalledOnce();
    expect(made.didPublish).toHaveBeenCalledOnce();
    expect(made.inner.hold.host.storage()).not.toBeNull();
    expect(made.node.getState().limited).toBeUndefined();
    await (made.inner.transport as PkarrTransport).publish(createIdentity(), []);
    expect(made.calls).toEqual(["publish"]);
    // Leaving twice does nothing twice.
    await made.node.leaveLimited();
    expect(made.startWallets).toHaveBeenCalledOnce();
  });

  it("called while the engine is still starting, it waits for the chats to be loaded, then dials them", async () => {
    const link = await profile();
    const made = engine(true);
    const starting = made.node.start();
    const leaving = made.node.leaveLimited();
    await Promise.all([starting, leaving]);
    expect(made.node.limited).toBe(false);
    expect(made.startLink.mock.calls.map((call) => call[0])).toEqual([link.id]);
    expect(made.startWallets).toHaveBeenCalledOnce();
    // An engine that was never started has nothing to leave.
    await expect(engine(true).node.leaveLimited()).rejects.toThrow("did not start");
  });

  it("a wallet that fails to start does not keep the chats from being dialled: they are, and the failure is reported", async () => {
    const link = await profile();
    const made = engine(true);
    await made.node.start();
    made.startWallets.mockRejectedValueOnce(new Error("the wallet database did not open"));
    await expect(made.node.leaveLimited()).rejects.toThrow("the wallet database did not open");
    expect(made.node.limited).toBe(false);
    expect(made.startLink.mock.calls.map((call) => call[0])).toEqual([link.id]);
    expect(made.holdStart).toHaveBeenCalledOnce();
    expect(made.node.getState().limited).toBeUndefined();
  });

  it("leaving it with the person's switch off opens the wallets and dials nothing", async () => {
    await profile();
    await db.putSettings({ online: false } as never);
    const made = engine(true);
    await made.node.start();
    await made.node.leaveLimited();
    expect(made.startWallets).toHaveBeenCalledOnce();
    expect(made.startLink).not.toHaveBeenCalled();
    expect(made.holdStart).not.toHaveBeenCalled();
  });
});

describe("what the pages may call in limited mode", () => {
  async function server(limited: boolean) {
    const { calls, transport } = recording();
    const made = new EngineServer({ transport, limited, automaticWallets: false });
    nodes.push((made as unknown as { node: GhostlyNode }).node);
    await made.ready;
    const answers: RpcResponse[] = [];
    const client = { post: (message: EngineEvent | RpcResponse) => { if (message.kind === "response") answers.push(message); } };
    const call = async (method: string, params: unknown = {}) => {
      await made.handle(client, { kind: "request", id: answers.length + 1, method, params } as unknown as RpcRequest);
      return answers.at(-1)!;
    };
    return { call, calls, made };
  }

  it("no wallet, payment, group, chat, call or identity call gets through; settings and history do", async () => {
    await profile();
    const { call, calls } = await server(true);
    const refused = ["walletCreate", "walletAddMint", "arkCreate", "usdtUnlock", "fedimintJoin", "sparkCreate", "barkCreate", "lightningSetSource", "bitcoinSetSource",
      "preparePayment", "approvePayment", "sendPayment", "payRequest", "walletPayQuote", "reconcilePayment",
      "createGroup", "inviteToGroup", "removeGroupMember", "makeGroupAdmin", "rotateGroup", "setGroupHub", "enableGroupLink", "joinGroupByLink", "leaveGroup", "renameGroup",
      "createLink", "takeInvite", "joinLink", "connect", "pollNow", "wake", "wakeForCall", "setCallSignal", "peekProfile", "sendFile",
      "beginIdentityProof", "completeIdentityProof", "setDidListed", "nostrPublish", "setWakeSubscription", "setChatHold"];
    for (const method of refused) expect((await call(method)).error, method).toBe(LIMITED_MODE_ERROR);
    // A delete withdraws a held item and a pending payment request, which limited mode cannot: refused, not half done.
    for (const method of ["deleteMessage", "retryMessage"]) expect((await call(method, { linkId: "x", messageId: "y" })).error, method).toBe(LIMITED_MODE_ERROR);
    expect((await call("updateSettings", { settings: { nick: "Ana" } })).error).toBeUndefined();
    expect((await call("setActiveLink", { linkId: null })).error).toBeUndefined();
    expect(calls).toEqual([]);
    // A list of what is allowed: a method added later is refused until someone decides.
    expect((await call("aMethodOfTomorrow")).error).toMatch(/Unknown method|could not check/);
    expect(LIMITED_MODE_METHODS.has("walletCreate")).toBe(false);
    expect([...LIMITED_MODE_METHODS].some((method) => /wallet(?!BackupReminder)|pay|ark|usdt|spark|bark|fedimint|lightning|bitcoin|invite|join|createLink|admin|rotate|identity|nostr|wake/i.test(method))).toBe(false);
  });

  it("a profile on one device starts through the gate as before, and its engine makes no turn read and no turn put", async () => {
    await profile();
    const { calls, transport } = recording();
    resetDeviceGates();
    const gate = await openDeviceGate();
    expect(gate).toMatchObject({ state: "single", full: true });
    const peer = await createPeerServer({ transport, automaticWallets: false }, { gate });
    nodes.push((peer as unknown as { node: GhostlyNode }).node);
    await peer.ready;
    expect(peer.gated).toBe(false);
    const node = (peer as unknown as { node: GhostlyNode }).node;
    expect(node.limited).toBe(false);
    // The engine runs: it reads its contact's record, publishes its own. None of it on the turn's path.
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0), { timeout: 5_000 });
    await flush();
    expect(calls.filter((call) => call.startsWith("turn"))).toEqual([]);
    // And no device state database was made for it.
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain("ghostly-devices");
  });

  it("outside limited mode a delete withdraws the held item and the pending payment request, as before this change", async () => {
    const link = await profile();
    // A payment request that never left (it waits for the chat to be live), and its message.
    const paymentId = "pay-1", messageId = "me_request";
    await db.putMessage({ linkId: link.id, id: messageId, text: "", sender: "me", timestamp: 5, via: "datalink", delivery: "waiting", paymentId } as never);
    const { call, made } = await server(false);
    const node = (made as unknown as { node: GhostlyNode }).node;
    const inner = node as unknown as { desk: { withdraw(id: string): Promise<void>; start(): Promise<void> }; hold: { forget(linkId: string, messageId: string): Promise<void> } };
    const withdraw = vi.spyOn(inner.desk, "withdraw"), forget = vi.spyOn(inner.hold, "forget");
    expect((await call("deleteMessage", { linkId: link.id, messageId })).error).toBeUndefined();
    await vi.waitFor(async () => expect(await db.getMessage(link.id, messageId)).toBeUndefined());
    // Exactly what the base branch does: the held item forgotten, the request withdrawn, the id remembered as deleted.
    expect(forget.mock.calls).toEqual([[link.id, messageId]]);
    expect(withdraw.mock.calls).toEqual([[paymentId]]);
    expect((await db.getLinks()).find((l) => l.id === link.id)?.deletedIds).toEqual([messageId]);
  });

  it("the start runs its steps in the order of the base branch: the wallets and the payment desk before the chats are loaded", async () => {
    await profile();
    const { calls, transport } = recording();
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false });
    nodes.push(node);
    const order: string[] = [];
    const inner = node as unknown as { desk: { start(): Promise<void> }; did: { start(): void }; groups: { load(): Promise<void> }; hold: { start(): void }; wallet: { start(): void } };
    const note = <T extends object>(target: T, method: keyof T & string, name: string) => {
      const original = (target[method] as unknown as (...args: unknown[]) => unknown).bind(target);
      vi.spyOn(target, method as never).mockImplementation(((...args: unknown[]) => { order.push(name); return original(...args); }) as never);
    };
    note(inner.did, "start", "did");
    note(inner.desk, "start", "desk");
    note(inner.wallet, "start", "wallet");
    note(inner.groups, "load", "groups");
    note(inner.hold, "start", "hold");
    await node.start();
    expect(order).toEqual(["did", "desk", "wallet", "groups", "hold"]);
    expect(calls.filter((call) => call.startsWith("turn"))).toEqual([]);
  });

  it("outside limited mode nothing is refused for it", async () => {
    await profile();
    const { call } = await server(false);
    expect((await call("peekProfile", {})).error ?? "").not.toBe(LIMITED_MODE_ERROR);
  });
});

describe("going online as the active device of a device set", () => {
  it("reads the turn before anything is dialled; with no good read the engine goes to limited mode instead", async () => {
    const { replaceDeviceGate } = await import("../src/devices/gate");
    const { databaseName } = await import("../src/shared/idb");
    await db.putSettings({ online: false } as never);
    await db.putLink(chat());
    const e = engine(false);
    await e.node.start();
    replaceDeviceGate({ profile: databaseName(), state: "active", full: true, view: null });
    try {
      await e.node.updateSettings({ settings: { online: true } });
      await flush();
      expect(e.startLink).not.toHaveBeenCalled();
      expect(e.holdStart).not.toHaveBeenCalled();
      expect(e.didPublish).not.toHaveBeenCalled();
      expect(e.node.limited).toBe(true);
    } finally { resetDeviceGates(); }
  });
});

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, type GhostRecord, type Identity, type PkarrTransport } from "@ghostly/core";
import { EngineServer } from "../src/engine/server";
import { db } from "../src/engine/db";
import { dropDataKey, hasDataKey, setDataKey } from "../src/engine/dataKey";
import { encryptProfile, type ProfileKeyHome } from "../src/engine/profileEncryption";
import type { ProfileKeyRecord } from "../src/shared/profileKey";
import { openDb, transact } from "../src/shared/idb";
import type { EngineEvent, RpcRequest, RpcResponse } from "../src/shared/rpc";
import type { StoredLink } from "../src/shared/types";

/*
 * The start gate of an encrypted profile (WISP 04, Encrypted profile, Unlock and lock; slice 5): until the passphrase
 * opens the data key, the engine makes no connection, no poll and no DHT read, starts no wallet and reads no store. A
 * wrong passphrase reads nothing either. Only the passphrase call is answered meanwhile.
 */

const PASSPHRASE = "throwaway passphrase 1";

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

function memoryHome(): ProfileKeyHome {
  let record: ProfileKeyRecord | null = null;
  return { read: async () => record, write: async (r) => { record = r; }, remove: async () => { record = null; } };
}

const chat = (): StoredLink => ({ id: "chat-1", profile: "paired-chat/1", createdAt: 1, seedB64: createIdentity().seedB64,
  encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64 });
const flush = (ms = 50) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const servers: EngineServer[] = [];
/** An engine over a recording transport, with spies on what the gate must hold back: store reads, wallets, dialling, fetch. */
function engine(profileKey?: { home: ProfileKeyHome; profile: string }) {
  const { calls, transport } = recording();
  const fetches = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in this test"));
  const reads = { settings: vi.spyOn(db, "getSettings"), links: vi.spyOn(db, "getLinks"), groups: vi.spyOn(db, "getGroups") };
  // A spy made again is the same one: what an engine made before read is not this one's.
  for (const read of Object.values(reads)) read.mockClear();
  const server = new EngineServer({ transport, automaticWallets: false, singleDevice: true, ...(profileKey ? { profileKey } : {}) });
  servers.push(server);
  const inner = server.node as unknown as Record<string, unknown>;
  const startWallets = vi.spyOn(inner as unknown as { startWallets(): Promise<void> }, "startWallets").mockResolvedValue();
  const startLink = vi.spyOn(inner as unknown as { startLink(id: string): void }, "startLink").mockImplementation(() => {});
  let started = false;
  void server.ready.then(() => { started = true; }, () => {});
  const posted: (EngineEvent | RpcResponse)[] = [];
  const client = { post: (message: EngineEvent | RpcResponse) => { posted.push(message); } };
  server.attach(client);
  const ask = (id: number, method: string, params?: unknown) => server.handle(client, { kind: "request", id, method, params } as RpcRequest);
  const answer = (id: number) => posted.find((m): m is RpcResponse => m.kind === "response" && m.id === id);
  return { server, calls, fetches, reads, startWallets, startLink, posted, ask, answer, started: () => started };
}

let home: ProfileKeyHome;
beforeEach(async () => {
  // PBKDF2 at 600,000 rounds costs about a second per call; the derivation runs with fewer rounds here.
  const derive = crypto.subtle.deriveKey.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "deriveKey").mockImplementation(((algorithm: Pbkdf2Params, ...rest: [CryptoKey, AesKeyGenParams, boolean, KeyUsage[]]) =>
    derive({ ...algorithm, iterations: 1_000 }, ...rest)) as typeof crypto.subtle.deriveKey);
  dropDataKey();
  const db0 = await openDb();
  await transact([...db0.objectStoreNames], (stores) => { for (const name of Object.keys(stores)) stores[name].clear(); });
  await db.putLink(chat());
  await db.putSettings({ online: true } as never);
  home = memoryHome();
  await encryptProfile(home, PASSPHRASE, "");
  dropDataKey();
});
afterEach(async () => {
  for (const server of servers.splice(0)) await server.node.shutdown({ quiet: true }).catch(() => {});
  dropDataKey();
  vi.restoreAllMocks();
});

describe("the start gate of an encrypted profile", () => {
  it("makes no request and reads no store before the passphrase; a wrong one changes nothing; the right one starts it", async () => {
    const made = engine({ home, profile: "" });
    void made.ask(1, "getState");
    await flush();
    const nothingYet = () => {
      expect(made.server.node.waitsForPassphrase).toBe(true);
      expect(made.started()).toBe(false);
      expect(made.calls).toEqual([]);
      expect(made.fetches).not.toHaveBeenCalled();
      expect(made.reads.settings).not.toHaveBeenCalled();
      expect(made.reads.links).not.toHaveBeenCalled();
      expect(made.reads.groups).not.toHaveBeenCalled();
      expect(made.startWallets).not.toHaveBeenCalled();
      expect(made.startLink).not.toHaveBeenCalled();
      expect(made.answer(1), "every other call waits for the start").toBeUndefined();
      expect(made.posted.filter((m) => m.kind === "state")).toEqual([]);
      expect(hasDataKey()).toBe(false);
    };
    nothingYet();

    await made.ask(2, "unlockProfile", { passphrase: "not the passphrase" });
    expect(made.answer(2)?.error).toContain("Wrong passphrase");
    await flush();
    nothingYet();

    await made.ask(3, "unlockProfile", { passphrase: PASSPHRASE });
    expect(made.answer(3)?.error).toBeUndefined();
    await made.server.ready;
    expect(hasDataKey()).toBe(true);
    expect(made.server.node.waitsForPassphrase).toBe(false);
    expect(made.startWallets).toHaveBeenCalledOnce();
    expect(made.startLink.mock.calls.map((call) => call[0])).toEqual(["chat-1"]);
    await flush();
    expect(made.answer(1)?.error).toBeUndefined();
    expect(made.server.node.getState().links.map((l) => l.id)).toEqual(["chat-1"]);

    // Asked again once open: nothing is waiting for it.
    await made.ask(4, "unlockProfile", { passphrase: PASSPHRASE });
    expect(made.answer(4)?.error).toContain("not waiting for its passphrase");
  });

  it("a profile without a record starts at once, as before, and so does one whose key a client already put in the slot", async () => {
    // The rows above were sealed when the record was made: a profile without a record starts here on an emptied store.
    const db0 = await openDb();
    await transact([...db0.objectStoreNames], (stores) => { for (const name of Object.keys(stores)) stores[name].clear(); });
    const plain = engine({ home: memoryHome(), profile: "" });
    await plain.server.ready;
    expect(plain.server.node.waitsForPassphrase).toBe(false);
    expect(plain.reads.settings).toHaveBeenCalled();
    await plain.server.node.shutdown({ quiet: true });

    // The CLI unwraps the key itself before the engine starts (profile-key.json): no gate.
    setDataKey(await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]));
    const keyed = engine({ home, profile: "" });
    await keyed.server.ready;
    expect(keyed.server.node.waitsForPassphrase).toBe(false);
  });

  it("stopping drops the data key: the next start asks for the passphrase again", async () => {
    const made = engine({ home, profile: "" });
    await made.ask(1, "unlockProfile", { passphrase: PASSPHRASE });
    await made.server.ready;
    expect(hasDataKey()).toBe(true);
    await made.server.node.shutdown({ quiet: true });
    expect(hasDataKey()).toBe(false);
    const again = engine({ home, profile: "" });
    await flush();
    expect(again.server.node.waitsForPassphrase).toBe(true);
    expect(again.reads.links).not.toHaveBeenCalled();
  });
});

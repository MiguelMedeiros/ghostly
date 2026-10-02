import "fake-indexeddb/auto";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { STORES, clearProfileStores, openDb, store, transact, wrap } from "../src/shared/idb";
import { registerFileBytes, resetFileBytes, type FileBytes } from "../src/shared/fileBytes";
import { setBrowserHost, type BrowserHost } from "../src/host";
import type { RpcRequest, RpcResponse } from "../src/shared/rpc";
import { LEGACY_JOIN_PREFIX, ensureSession, listSessions, markJoinAnnounced, setStorageProfile } from "../../../apps/ui/src/lib/storage";
import { createProfile, listProfiles, registryKey } from "../../../apps/ui/src/lib/profiles";
import { setPushPlatform, type PushPlatform } from "../../../apps/ui/src/lib/wakePush";
import { clearAllData } from "../../../apps/ui/src/lib/clearData";
// covers: app.clear-data

/**
 * "Clear all data" (WISP 04) on a profile that holds one of every kind of thing: afterwards nothing of the profile is
 * left but its wallets, and nothing of another profile or of the list of profiles is touched.
 */

class FakeStorage {
  entries = new Map<string, string>();
  get length() { return this.entries.size; }
  key(i: number) { return [...this.entries.keys()][i] ?? null; }
  getItem(k: string) { return this.entries.get(k) ?? null; }
  setItem(k: string, v: string) { this.entries.set(k, v); }
  removeItem(k: string) { this.entries.delete(k); }
}

/** The origin-private file system: this profile's files (`ghostly-files`) and a Fedimint client file beside them. */
const opfs = new Set<string>();
const fakeFiles = { kind: "opfs", async removeWhere(prefix: string) { for (const f of [...opfs]) if (f.startsWith(`ghostly-files/ghostly/${prefix}`)) opfs.delete(f); } } as unknown as FileBytes;

const push = { unsubscribed: [] as string[] };
const pushPlatform: PushPlatform = {
  supported: () => true,
  subscribe: async () => ({ endpoint: "", p256dh: "", auth: "" }),
  current: async () => null,
  unsubscribe: async (profile) => { push.unsubscribed.push(profile); },
  syncTable: async () => {},
};

/** A peer that answers like the real one would: `clearProfileData` empties its database (the node's part is tested apart). */
let peer: ((request: RpcRequest) => Promise<unknown>) | null = null;
const restarted = vi.fn(async () => {});
const host = {
  version: "test",
  features: { shareLocalServices: false, openServices: false, profiles: true },
  restartEngine: restarted,
  async connect(onMessage: (message: RpcResponse) => void) {
    return {
      send: (request: RpcRequest) => {
        const answer = peer ? peer(request) : Promise.reject(new Error("no peer"));
        void answer.then((result) => onMessage({ kind: "response", id: request.id, result }), (error: Error) => onMessage({ kind: "response", id: request.id, error: error.message }));
      },
    };
  },
  requestLocalAccess: async () => false,
  openService: async () => {},
} as unknown as BrowserHost;

let storage: FakeStorage;
beforeEach(async () => {
  storage = new FakeStorage();
  setStorageProfile("");
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  Object.defineProperty(globalThis, "window", { value: { dispatchEvent: vi.fn(), addEventListener: vi.fn(), location: { hash: "", reload: vi.fn() }, history: { replaceState: vi.fn() } }, configurable: true });
  opfs.clear();
  resetFileBytes(["opfs"]);
  registerFileBytes("opfs", async () => fakeFiles);
  registerFileBytes("idb", async () => null);
  setPushPlatform(pushPlatform);
  push.unsubscribed = [];
  restarted.mockClear();
  setBrowserHost(host);
  for (const db of await indexedDB.databases()) if (db.name && db.name !== "ghostly") await wrap(indexedDB.deleteDatabase(db.name));
  await clearEverything();
});
afterAll(() => { setPushPlatform(null); resetFileBytes(); });

/** Wipes the peer database between tests (all stores, wallets included). */
async function clearEverything() {
  const db = await openDb();
  const tx = db.transaction([...db.objectStoreNames], "readwrite");
  for (const name of db.objectStoreNames) tx.objectStore(name).clear();
  await new Promise((resolve) => { tx.oncomplete = resolve; });
}

const WALLET_SETTINGS = {
  mints: ["https://mint.test"],
  mintsInitialized: true,
  walletSetup: { state: "done" },
  backupReminders: { "cashu:mainnet": { since: 1 } },
};
/** Records of the settings store that are a wallet's, as each wallet names them. */
const WALLET_RECORDS: Record<string, unknown> = {
  "arkWallet-mode-testnet": { config: { walletId: "ark1" } },
  "arkWallet-retired-1": { config: { walletId: "ark0" } },
  "barkWallet-mode-testnet": { config: { walletId: "bark1" } },
  "fedimintWallet-testnet": { federations: [{ id: "f1", database: "ghostly-fedimint-f1.db" }] },
  "fedimintRetired-testnet-f0": { id: "f0" },
  "fedimintReceive-op1": { operationId: "op1" },
  "sparkWallet-mode-mainnet": { seed: "sealed" },
  "sparkWallet-retired-2": { seed: "sealed" },
  "usdtWallet-mode-testnet": { seed: "sealed" },
  "lightningOp-in-abc": { direction: "in" },
  "bdkWallet-testnet-0123": { changeset: 1 },
  "nwcSource-testnet": { sealed: 1 },
  "nwcSourceSeen-testnet": { at: 1 },
};
/** Records of the settings store that are the profile's. */
const PROFILE_RECORDS: Record<string, unknown> = {
  profileDid: { publicKey: "did-key", seed: { sealed: 1 }, listed: [] },
  identityProofs: [{ binding: { key: "proof-key" }, seed: { sealed: 1 } }],
  identityRevocations: [{ id: "r", seed: { sealed: 1 } }],
  nostrSocial: { npub: { subject: "npub" } },
  publicProfiles: { "nostr:npub": { name: "Alice" } },
};

async function seedProfile() {
  // The page's part: a chat, its join flag, an older join flag, settings with a lock and backup storage.
  const chatId = ensureSession({ seedB64: "c2VlZA", peerPubKeyB64: "alicepeer", encKeyB64: "ZW5j" });
  markJoinAnnounced(chatId);
  storage.setItem(`${LEGACY_JOIN_PREFIX}e7c0f1a2b3c4d5e6f708192a3b4c5d6e`, "true");
  storage.setItem("ghostly_app_settings", JSON.stringify({ defaultNickname: "Alice", lockScreen: { enabled: true, passwordHash: "x" }, backupS3: { bucket: "b" }, backupSpace: "space" }));
  storage.setItem("ghostly_pinned", "[]");

  // The peer's part: one record in every store.
  await transact(Object.values(STORES), (s) => {
    s[STORES.links].put({ id: "l1", seed: "chat-seed" });
    s[STORES.messages].put({ linkId: "l1", id: "m1", timestamp: 1, text: "hi" });
    s[STORES.files].put({ id: "l1-in-f", linkId: "l1", createdAt: 1 });
    s[STORES.fileState].put({ id: "l1-in-f" });
    s[STORES.fileChunks].put({ id: "l1-in-f", index: 0 });
    s[STORES.services].put({ id: "svc" });
    s[STORES.groups].put({ id: "g1", secret: "epoch" });
    s[STORES.proofs].put({ secret: "coin", amount: 64 });
    s[STORES.payments].put({ id: "pay", linkId: "l1" });
    s[STORES.quotes].put({ quote: "q" });
    s[STORES.walletTx].put({ id: "tx" });
    s[STORES.melts].put({ quote: "melt" });
    s[STORES.intents].put({ review: { id: "intent" } });
    s[STORES.settings].put({
      online: true, nick: "Alice", avatar: "data:image/jpeg;base64,AAAA", relays: ["https://relay.test"], iceServers: [{ urls: "turn:t" }],
      nostr: { relays: ["wss://n"], autoLoadProfiles: true, publish: true }, holdStorage: { s3: { bucket: "b" }, space: "space" },
      wake: { endpoint: "https://push.test/x", p256dh: "p", auth: "a", vapid: { publicKey: "v", privateKey: "v" } }, wakeMutedGroups: ["g1"],
      pushRelay: "https://relay.push", ...WALLET_SETTINGS,
    }, "settings");
    for (const [key, value] of Object.entries({ ...WALLET_RECORDS, ...PROFILE_RECORDS })) s[STORES.settings].put(value, key);
  });

  // Wallet storage outside the peer database (#889), and this profile's files.
  for (const name of ["ghostly-ark-ark1", "ghostly-bark-bark1", "ghostly-bark-bark1-onchain"]) {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore("data"); };
    (await wrap(request)).close();
  }
  opfs.add("ghostly-fedimint-f1.db");
  opfs.add("ghostly-files/ghostly/l1-in-f");
  opfs.add("ghostly-files/ghostly/l1-out-g");
}

/** Every record of a store, by key. */
async function records(name: string): Promise<Map<IDBValidKey, unknown>> {
  const s = await store(name, "readonly");
  const [keys, values] = await Promise.all([wrap(s.getAllKeys()), wrap(s.getAll())]);
  return new Map(keys.map((k, i) => [k, values[i]]));
}

async function expectOnlyWalletsLeft() {
  // Nothing of the profile in the page's storage; the list of profiles and another profile's keys stay.
  expect(listSessions()).toEqual([]);
  const left = [...storage.entries.keys()];
  expect(left.filter((k) => !k.startsWith("ghostly_profiles") && !/^ghostly_[a-z0-9]{10}_/.test(k)), "the profile's own keys").toEqual([]);

  // Nothing of the profile in its peer database.
  for (const name of [STORES.links, STORES.messages, STORES.files, STORES.fileState, STORES.fileChunks, STORES.services, STORES.groups]) {
    expect((await records(name)).size, name).toBe(0);
  }
  const settings = await records(STORES.settings);
  expect(settings.get("settings"), "name, picture, network, held-item storage and push subscription go; the wallet fields stay").toEqual(WALLET_SETTINGS);
  for (const key of Object.keys(PROFILE_RECORDS)) expect(settings.has(key), key).toBe(false);
  expect(Object.fromEntries([...settings].filter(([k]) => k !== "settings")), "every wallet record, as it was").toEqual(WALLET_RECORDS);

  // The wallets as they were.
  for (const [name, count] of [[STORES.proofs, 1], [STORES.payments, 1], [STORES.quotes, 1], [STORES.walletTx, 1], [STORES.melts, 1], [STORES.intents, 1]] as const) {
    expect((await records(name)).size, name).toBe(count);
  }
  const databases = (await indexedDB.databases()).map((d) => d.name);
  expect(databases).toEqual(expect.arrayContaining(["ghostly-ark-ark1", "ghostly-bark-bark1", "ghostly-bark-bark1-onchain"]));
  expect([...opfs], "the files go, the Fedimint client file stays").toEqual(["ghostly-fedimint-f1.db"]);

  // Outside the device: the push subscription ends at the push service.
  expect(push.unsubscribed).toEqual([""]);
}

it("leaves nothing of the profile but its wallets, with the peer doing its part", async () => {
  const work = createProfile("Work");
  setStorageProfile(work.id);
  ensureSession({ seedB64: "c2VlZA", peerPubKeyB64: "workpeer", encKeyB64: "ZW5j" });
  setStorageProfile("");
  await seedProfile();
  const asked: string[] = [];
  peer = async (request) => { asked.push(request.method); if (request.method === "clearProfileData") await clearProfileStores(); return null; };

  await clearAllData();

  expect(asked).toEqual(["clearProfileData"]);
  await expectOnlyWalletsLeft();
  expect(restarted, "a peer that outlives the page starts again").toHaveBeenCalledOnce();
  expect(storage.getItem(registryKey())).not.toBeNull();
  expect(listProfiles().map((p) => p.name)).toEqual(["Personal", "Work"]);
  setStorageProfile(work.id);
  expect(listSessions().map((s) => s.peerPubKeyB64), "another profile's chats stay").toEqual(["workpeer"]);
});

it("leaves nothing of the profile but its wallets even when the peer does not answer", async () => {
  await seedProfile();
  peer = async () => { throw new Error("The peer is gone"); };

  await clearAllData();

  await expectOnlyWalletsLeft();
});

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Amount, OutputData, getEncodedToken, type Proof, type SerializedSwapPreview, type SwapPreview } from "@cashu/cashu-ts";
import { db } from "../src/engine/db";
import { dropDataKey, setDataKey } from "../src/engine/dataKey";
import { CashuWallet, SwapUnsettledError } from "../src/engine/wallet";
import { createProfileKey } from "../src/shared/profileKey";
import { STORES, clearProfileStores, openDb, transact, wrap } from "../src/shared/idb";
import type { PendingSwap, StoredGroup, StoredLink } from "../src/shared/types";
// covers: wallet.cashu.receive-token, payments.cashu.send

/*
 * The encrypted profile's phase 1 fields (WISP 04, slice 3): with the data key set, chats, groups and the Cashu wallet
 * write their secrets sealed and read them back opened; a raw read of the database finds none of them. Without the
 * key, rows are stored as they always were.
 */

const mintApi = vi.hoisted(() => ({
  sendOffline: vi.fn(), prepareSend: vi.fn(), prepareReceive: vi.fn(), completeSwap: vi.fn(), restore: vi.fn(), getKeys: vi.fn(), checkProofsStates: vi.fn(),
}));
vi.mock("@cashu/cashu-ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("@cashu/cashu-ts")>();
  return {
    ...real,
    Wallet: class {
      constructor(readonly url: string) {}
      async loadMint(): Promise<void> {}
      getMintInfo = () => ({ isSupported: () => ({ supported: true, params: [] }) });
      sendOffline = (...args: unknown[]) => mintApi.sendOffline(...args);
      getFeesForProofs = () => real.Amount.zero();
      getFeesToInclude = () => real.Amount.zero();
      selectProofsToSend = (proofs: { amount: number }[]) => ({ keep: [], send: proofs.map((p) => ({ ...p, amount: real.Amount.from(p.amount) })) });
      prepareSwapToSend = (...args: unknown[]) => mintApi.prepareSend(...args);
      prepareSwapToReceive = (...args: unknown[]) => mintApi.prepareReceive(...args);
      completeSwap = (preview: unknown) => mintApi.completeSwap(preview);
      mint = { restore: (request: unknown) => mintApi.restore(request), getKeys: () => mintApi.getKeys() };
      checkProofsStates = (proofs: unknown) => mintApi.checkProofsStates(proofs);
    },
  };
});

/** PBKDF2 at 600,000 rounds costs about a second per call; the derivation runs with fewer rounds here. */
const derive = crypto.subtle.deriveKey.bind(crypto.subtle);
const dataKey = async () => {
  vi.spyOn(crypto.subtle, "deriveKey").mockImplementationOnce(((algorithm: Pbkdf2Params, ...rest: [CryptoKey, AesKeyGenParams, boolean, KeyUsage[]]) =>
    derive({ ...algorithm, iterations: 1_000 }, ...rest)) as typeof crypto.subtle.deriveKey);
  return (await createProfileKey("throwaway passphrase 1", "")).key;
};

/** Every row of every store, as a reader of the profile's files would find it. */
async function rawDatabase(): Promise<string> {
  const database = await openDb();
  const names = [...database.objectStoreNames];
  const tx = database.transaction(names, "readonly");
  return JSON.stringify(await Promise.all(names.map((name) => wrap(tx.objectStore(name).getAll()))));
}
const leaks = async (secrets: readonly string[]) => { const raw = await rawDatabase(); return secrets.filter((secret) => raw.includes(secret)); };

beforeEach(async () => {
  dropDataKey();
  await clearProfileStores();
  await transact([STORES.proofs, STORES.payments, STORES.walletTx, STORES.swaps, STORES.melts, STORES.quotes], (s) => { for (const name of Object.keys(s)) s[name].clear(); });
});
afterEach(() => { dropDataKey(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("chats", () => {
  const SEEDS = { seedB64: "chat-seed-of-a-throwaway-link", encKeyB64: "chat-enc-key-of-a-throwaway-link", participationSeed: "participation-seed-of-a-throwaway-link" };
  const NATIVE = "native-iroh-seed-of-a-throwaway-link";
  const INVITE = "ghostly1-invite-code-of-a-throwaway-link";
  const PEER = "pinned-contact-key-of-a-throwaway-link";
  const link: StoredLink = { id: "l1", peerPubKeyZ32: "public-key", createdAt: 1, profile: "paired-chat/1", ...SEEDS, inviteCode: INVITE, transportSeeds: { iroh: NATIVE } };

  it("with the data key, seeds, keys, invite codes and the pinned key are sealed, and read back as they were", async () => {
    setDataKey(await dataKey());
    await db.putLink(link);
    expect(await db.getLinks()).toEqual([link]);
    await db.pinPeer("l1", PEER);
    await db.verifyPeer("l1", PEER);
    await db.patchLink("l1", { label: "Ana" });
    const [read] = await db.getLinks();
    expect(read).toMatchObject({ ...SEEDS, transportSeeds: { iroh: NATIVE }, pairedPeerKey: PEER, peerTrust: { verifiedKey: PEER }, label: "Ana" });
    expect(read.inviteCode, "taken out once the contact is pinned").toBeUndefined();
    await expect(db.pinPeer("l1", "another-key"), "the sealed pinned key is still compared").rejects.toThrow();
    await expect(db.verifyPeer("l1", "another-key")).rejects.toThrow();
    expect(await leaks([...Object.values(SEEDS), NATIVE, PEER])).toEqual([]);
  });

  it("an invite code written by a patch is sealed too", async () => {
    setDataKey(await dataKey());
    await db.putLink({ ...link, inviteCode: undefined });
    await db.patchLink("l1", { inviteCode: INVITE });
    expect((await db.getLinks())[0].inviteCode).toBe(INVITE);
    expect(await leaks([INVITE])).toEqual([]);
  });

  it("without the data key, the row is stored as it was given", async () => {
    await db.putLink(link);
    const raw = await wrap((await openDb()).transaction(STORES.links, "readonly").objectStore(STORES.links).get("l1"));
    expect(raw).toEqual(link);
  });
});

describe("groups and communities", () => {
  const SECRETS = ["member-seed-of-a-group", "epoch-secret-of-a-group", "invited-seed-of-a-group", "link-entry-seed-of-a-group",
    "community-member-seed", "community-epoch-secret", "community-entry-seed", "community-rendezvous-secret", "joining-seed", "previous-member-seed"];
  const group = {
    id: "g1", createdAt: 1,
    invitation: { name: "G", admin: "a", linkId: "l1", e: 0, n: 0, pieces: [], seedB64: SECRETS[2] },
    entry: { seedB64: SECRETS[3], createdAt: 1 },
    state: { id: "g1", name: "G", seedB64: SECRETS[0], secrets: { 0: SECRETS[1] }, chain: [] },
    community: { id: "g1", seedB64: SECRETS[4], secrets: { h: SECRETS[5] }, entry: { key: "entry-public-key", seedB64: SECRETS[6] }, rv: SECRETS[7] },
    joining: { g: "g2", host: "h", seedB64: SECRETS[8], linkId: "l1", name: "J", inviter: "i", pieces: [], since: 1 },
    previous: { id: "g1", createdAt: 0, state: { id: "g1", seedB64: SECRETS[9], secrets: {} } },
  } as unknown as StoredGroup;

  it("with the data key, every member seed, epoch secret, entry seed and rendezvous secret is sealed", async () => {
    setDataKey(await dataKey());
    await db.putGroup(group);
    expect(await db.getGroups()).toEqual([group]);
    expect(await leaks(SECRETS)).toEqual([]);
  });

  it("without it, they are stored as they are", async () => {
    await db.putGroup(group);
    expect(await leaks(SECRETS)).toEqual(SECRETS);
  });
});

describe("the Cashu wallet", () => {
  const MINT = "https://mint.example";
  const KEYSET = "009a1f293253e41e";
  const C = `02${"ab".repeat(32)}`;
  const proof = (amount: number, secret: string): Proof => ({ id: KEYSET, amount: Amount.from(amount), secret, C }) as Proof;
  const outputs = (...amounts: number[]) => amounts.map((amount) => OutputData.createSingleRandomData(amount, KEYSET));
  const TOKEN_SECRET = "secret-of-the-coin-in-the-token";
  const TOKEN = getEncodedToken({ mint: MINT, unit: "sat", proofs: [proof(64, TOKEN_SECRET)] });
  const RECEIVED = ["received-coin-32", "received-coin-16", "received-coin-8", "received-coin-4", "received-coin-2"];
  const signed = (swap: PendingSwap) => {
    const saved = swap.swap as SerializedSwapPreview;
    const made = [...(saved.keepOutputs ?? []), ...(saved.sendOutputs ?? [])];
    return { outputs: made.map((o) => ({ B_: o.blindedMessage.B_ })), signatures: made.map((o) => ({ id: o.blindedMessage.id, amount: o.blindedMessage.amount, C_: C })) };
  };
  const idle = async () => { for (let i = 0; i < 25; i++) await new Promise((resolve) => setImmediate(resolve)); };
  const setup = () => {
    const events = { onChange: vi.fn(), onTestMintNeeded: vi.fn(), onQuotePaid: vi.fn(), onMeltResolved: vi.fn(), onSwapSettled: vi.fn() };
    return { wallet: new CashuWallet(() => [MINT], events), events };
  };
  /** What the wallet holds, as it reads it: every secret it may spend with. */
  const held = async (wallet: CashuWallet) => {
    const { proofs, swaps } = await wallet.readStored();
    const saved = swaps.map((s) => s.swap as SerializedSwapPreview);
    const outputSecrets = saved.flatMap((s) => [...(s.keepOutputs ?? []), ...(s.sendOutputs ?? [])].map((o) => o.secret));
    return [...proofs.map((p) => p.secret), ...saved.flatMap((s) => s.inputs.map((p) => p.secret)), ...outputSecrets];
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    mintApi.sendOffline.mockImplementation(() => { throw new Error("No exact coins"); });
    mintApi.prepareReceive.mockImplementation(async () => ({ amount: Amount.from(62), fees: Amount.from(2), keysetId: KEYSET, inputs: [proof(64, TOKEN_SECRET)], keepOutputs: outputs(32, 16, 8, 4, 2) }) as SwapPreview);
    mintApi.prepareSend.mockImplementation(async () => ({ amount: Amount.from(20), fees: Amount.from(4), keysetId: KEYSET, inputs: [proof(32, RECEIVED[0])], keepOutputs: outputs(8), sendOutputs: outputs(16, 4) }) as SwapPreview);
    mintApi.getKeys.mockResolvedValue({ keysets: [{ id: KEYSET, unit: "sat", keys: {} }] });
    vi.spyOn(OutputData.prototype, "toProof").mockImplementation(function (this: OutputData) {
      return { id: KEYSET, amount: Amount.from(this.blindedMessage.amount), secret: new TextDecoder().decode(this.secret), C } as Proof;
    });
  });

  it("with the data key, a token redeemed, a swap written down and the ecash it makes keep no secret in the clear", async () => {
    setDataKey(await dataKey());
    mintApi.completeSwap.mockImplementationOnce(async () => {
      expect(await leaks([TOKEN, TOKEN_SECRET]), "the redeem written down before the mint is asked").toEqual([]);
      return { keep: RECEIVED.map((secret, i) => proof(32 >> i, secret)), send: [] };
    });
    const first = setup();
    await expect(first.wallet.receiveToken(TOKEN, "ecash-in")).resolves.toMatchObject({ amount: 62 });
    expect(await first.wallet.balance()).toBe(62);
    expect(await leaks(RECEIVED)).toEqual([]);

    // A split whose answer never arrives: its inputs held and the swap written down, all sealed.
    mintApi.completeSwap.mockRejectedValue(new TypeError("Failed to fetch"));
    mintApi.restore.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(first.wallet.createToken(20)).rejects.toBeInstanceOf(SwapUnsettledError);
    expect(await first.wallet.balance(), "the input is held").toBe(30);
    const secrets = await held(first.wallet);
    expect(secrets).toContain(RECEIVED[0]);
    expect(await leaks(secrets)).toEqual([]);
    const [kept] = (await first.wallet.readStored()).swaps;
    await first.wallet.stop();

    // The next start reads the sealed swap, and the mint's answer brings back everything it made.
    mintApi.restore.mockImplementation(async () => signed(kept));
    const next = setup();
    next.wallet.start();
    await idle();
    await vi.waitFor(() => expect(next.events.onSwapSettled).toHaveBeenCalledWith(expect.objectContaining({ id: kept.id }), true));
    expect(await next.wallet.balance()).toBe(62 - 4);
    expect((await next.wallet.readStored()).swaps).toEqual([]);
    const now = await held(next.wallet);
    expect(now).not.toContain(RECEIVED[0]);
    expect(await leaks([...now, RECEIVED[0]])).toEqual([]);
    await next.wallet.stop();
  });

  it("without it, the wallet's rows are stored as they always were", async () => {
    mintApi.completeSwap.mockResolvedValueOnce({ keep: RECEIVED.map((secret, i) => proof(32 >> i, secret)), send: [] });
    const { wallet } = setup();
    await wallet.receiveToken(TOKEN, "ecash-in");
    const raw = await wrap((await openDb()).transaction(STORES.proofs, "readonly").objectStore(STORES.proofs).getAll());
    expect(raw).toEqual(RECEIVED.map((secret, i) => ({ mint: MINT, id: KEYSET, amount: 32 >> i, secret, C })).sort((a, b) => (a.secret < b.secret ? -1 : 1)));
  });
});

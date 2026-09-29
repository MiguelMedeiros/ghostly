import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Amount, OutputData, type Proof, type SwapPreview } from "@cashu/cashu-ts";
import type { PaymentTarget } from "@ghostly/core";
import { CashuWallet, type CashuPrepared } from "../src/engine/wallet";
import { CASHU_REQUEST_TIMEOUT_MS, CashuAdapter, NEVER_REACHED_MINT, SWAP_SETTLED_MS } from "../src/engine/paymentAdapters/cashu";
import { PaymentCoordinator } from "../src/engine/paymentAdapters/coordinator";
import { intentRepository } from "../src/engine/paymentAdapters/persistence";
import { STORES, store, transact, wrap } from "../src/shared/idb";
import type { StoredProof } from "../src/shared/types";
// covers: payments.chat.reconcile, payments.cashu.send

/**
 * A reviewed Cashu payment approved while its mint was unreachable: the swap never left, its inputs stay reserved, and
 * reconcile used to say "unknown" forever. Only the mint's own word ends it: every input UNSPENT and no output signed,
 * past the time a swap could still be on its way. Then it failed, its inputs come back, and the request can be paid.
 */
const mintApi = vi.hoisted(() => ({ prepare: vi.fn(), completeSwap: vi.fn(), restore: vi.fn(), getKeys: vi.fn(), checkProofsStates: vi.fn() }));
vi.mock("@cashu/cashu-ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cashu/cashu-ts")>()),
  Wallet: class {
    constructor(readonly url: string) {}
    async loadMint(): Promise<void> {}
    ops = { send: (amount: number, proofs: unknown[]) => ({ includeFees: (on: boolean) => ({ prepare: () => mintApi.prepare(amount, proofs, on) }) }) };
    completeSwap = (preview: unknown) => mintApi.completeSwap(preview);
    mint = { restore: (request: unknown) => mintApi.restore(request), getKeys: () => mintApi.getKeys() };
    checkProofsStates = (proofs: unknown) => mintApi.checkProofsStates(proofs);
  },
}));

const MINT = "https://mint.example";
const KEYSET = "009a1f293253e41e";
const C = `02${"ab".repeat(32)}`;
const proof = (amount: number, secret: string): Proof => ({ id: KEYSET, amount: Amount.from(amount), secret, C }) as Proof;
const target: PaymentTarget = { method: "cashu", network: "bitcoin", provider: MINT, asset: "BTC", unit: "sat", address: "creqA", expiresAt: Date.now() + 3_600_000 };
const context = { payee: "alice", linkId: "chat-1", requestId: "req-1" };
const all = async <T>(name: string) => wrap<T[]>((await store(name, "readonly")).getAll());
/** A swap's longest life after its approval: past it, nothing of it can still reach the mint. */
const GATE = CASHU_REQUEST_TIMEOUT_MS + SWAP_SETTLED_MS;
const reserved = async () => (await all<StoredProof>(STORES.proofs)).filter((p) => p.reserved).map((p) => p.secret);

/** 64 sats in; 40 sent as 32 + 8; 16 kept; 8 of fees. */
const preview = () => ({
  amount: Amount.from(40), fees: Amount.from(8), keysetId: KEYSET, inputs: [proof(64, "in")],
  keepOutputs: [OutputData.createSingleRandomData(16, KEYSET)],
  sendOutputs: [OutputData.createSingleRandomData(32, KEYSET), OutputData.createSingleRandomData(8, KEYSET)],
}) as unknown as SwapPreview;

/** What the mint says about each proof: the input by name, every output the same. */
function mintSays(input: "UNSPENT" | "PENDING" | "SPENT", outputs: "UNSPENT" | "SPENT" = "UNSPENT") {
  mintApi.checkProofsStates.mockImplementation(async (proofs: { secret: string }[]) => proofs.map((p) => ({ state: p.secret === "in" ? input : outputs })));
}

function setup() {
  const wallet = new CashuWallet(() => [MINT], { onChange: vi.fn(), onTestMintNeeded: vi.fn(), onQuotePaid: vi.fn(), onMeltResolved: vi.fn() });
  const published: string[] = [];
  const adapter = new CashuAdapter(wallet, async (_review, token) => { published.push(token); });
  return { wallet, adapter, published, coordinator: new PaymentCoordinator(intentRepository, [adapter]) };
}

/** Bob approves a 40-sat payment of the request while the mint cannot be reached: it is left "unknown". */
async function approvedWhileMintDown(t: ReturnType<typeof setup>) {
  mintApi.prepare.mockResolvedValue(preview());
  const review = await t.coordinator.prepare(target, 40, 20, context);
  mintApi.completeSwap.mockRejectedValue(new TypeError("Failed to fetch"));
  expect((await t.coordinator.approve(review.id)).state).toBe("unknown");
  expect(await reserved()).toEqual(["in"]);
  return review;
}

beforeEach(async () => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-29T12:00:00Z") });
  await transact([STORES.proofs, STORES.payments, STORES.walletTx, STORES.intents], (s) => { s[STORES.proofs].clear(); s[STORES.payments].clear(); s[STORES.walletTx].clear(); s[STORES.intents].clear(); });
  await transact([STORES.proofs], (s) => s[STORES.proofs].put({ mint: MINT, id: KEYSET, amount: 64, secret: "in", C }));
  mintApi.restore.mockResolvedValue({ outputs: [], signatures: [] });
});
afterEach(() => { vi.useRealTimers(); });

describe("a Cashu payment whose swap never reached the mint", () => {
  it("fails once the mint says nothing was spent and nothing signed, gives its sats back, and the request can be paid again", async () => {
    const t = setup();
    const review = await approvedWhileMintDown(t);
    // The mint is back: every input UNSPENT, no output signed. Past the time a swap could still arrive.
    mintSays("UNSPENT");
    vi.setSystemTime(Date.now() + GATE + 1);
    const release = vi.spyOn(t.wallet, "releaseReviewedCashu");
    release.mockImplementation(async function (this: CashuWallet, prepared: CashuPrepared) {
      // Marked for good before anything comes back: a reload repeats only the release.
      expect(((await intentRepository.get(review.id))!.prepared as CashuPrepared).abandoned).toBe(true);
      return CashuWallet.prototype.releaseReviewedCashu.call(this, prepared);
    });
    const failed = await t.coordinator.reconcile(review.id);
    expect(failed).toMatchObject({ state: "failed", error: NEVER_REACHED_MINT });
    expect(release).toHaveBeenCalledOnce();
    expect(await reserved()).toEqual([]);
    expect(t.published).toEqual([]);
    // The saved swap was never sent again, and a later reconcile does nothing more.
    expect(mintApi.completeSwap).toHaveBeenCalledOnce();
    expect((await t.coordinator.reconcile(review.id)).state).toBe("failed");
    expect(mintApi.completeSwap).toHaveBeenCalledOnce();

    // The same request can be paid again, with the same sats.
    mintApi.prepare.mockResolvedValue(preview());
    mintApi.completeSwap.mockResolvedValue({ keep: [proof(16, "k")], send: [proof(32, "s1"), proof(8, "s2")] });
    const again = await t.coordinator.prepare(target, 40, 20, context);
    expect((await t.coordinator.approve(again.id)).state).not.toBe("unknown");
    expect(t.published).toHaveLength(1);
  });

  it("a swap that went through with its answer lost is recovered: its token goes out, and it settles once taken, never failed", async () => {
    const t = setup();
    const review = await approvedWhileMintDown(t);
    vi.setSystemTime(Date.now() + GATE + 1);
    // The mint did the swap: the input is spent, the outputs are signed but the contact has not taken them yet.
    mintSays("SPENT", "UNSPENT");
    mintApi.getKeys.mockResolvedValue({ keysets: [{ id: KEYSET, unit: "sat", keys: {} }] });
    vi.spyOn(OutputData.prototype, "toProof").mockImplementation(function (this: OutputData) {
      return { id: KEYSET, amount: Amount.from(this.blindedMessage.amount), secret: new TextDecoder().decode(this.secret), C } as Proof;
    });
    mintApi.restore.mockImplementation(async ({ outputs }: { outputs: { B_: string; id: string; amount: number }[] }) =>
      ({ outputs: outputs.map((o) => ({ B_: o.B_ })), signatures: outputs.map((o) => ({ id: o.id, amount: o.amount, C_: C })) }));
    const release = vi.spyOn(t.wallet, "releaseReviewedCashu");
    expect((await t.coordinator.reconcile(review.id)).state).toBe("unknown");
    expect(t.published).toHaveLength(1);
    mintSays("SPENT", "SPENT");
    expect((await t.coordinator.reconcile(review.id)).state).toBe("settled");
    expect(release).not.toHaveBeenCalled();
  });

  it("an input the mint reads PENDING keeps it unknown, its sats reserved", async () => {
    const t = setup();
    const review = await approvedWhileMintDown(t);
    vi.setSystemTime(Date.now() + GATE + 1);
    mintSays("PENDING");
    expect((await t.coordinator.reconcile(review.id)).state).toBe("unknown");
    expect(await reserved()).toEqual(["in"]);
  });

  it("an input the mint reads SPENT with nothing signed keeps it unknown", async () => {
    const t = setup();
    const review = await approvedWhileMintDown(t);
    vi.setSystemTime(Date.now() + GATE + 1);
    mintSays("SPENT");
    expect((await t.coordinator.reconcile(review.id)).state).toBe("unknown");
    expect(await reserved()).toEqual(["in"]);
  });

  it("younger than the gate, it stays unknown: a swap could still be on its way", async () => {
    const t = setup();
    const review = await approvedWhileMintDown(t);
    mintSays("UNSPENT");
    vi.setSystemTime(Date.now() + GATE - 1_000);
    expect((await t.coordinator.reconcile(review.id)).state).toBe("unknown");
    expect(await reserved()).toEqual(["in"]);
    // Timed from the approval, saved with it: a new coordinator (a reload) reads the same age.
    const saved = (await intentRepository.get(review.id))!.review;
    expect(saved.submittedAt).toBeGreaterThanOrEqual(saved.createdAt);
    vi.setSystemTime(saved.submittedAt! + GATE);
    expect((await new PaymentCoordinator(intentRepository, [t.adapter]).reconcile(review.id)).state).toBe("failed");
    expect(await reserved()).toEqual([]);
  });

  it("an approval whose swap took long to fail waits SWAP_SETTLED_MS from when it failed, not from when it began", async () => {
    const t = setup();
    mintApi.prepare.mockResolvedValue(preview());
    const review = await t.coordinator.prepare(target, 40, 20, context);
    // The request hung for 10 minutes (retries of a swap, NUT-19) before it failed.
    mintApi.completeSwap.mockImplementation(async () => { vi.setSystemTime(Date.now() + 10 * 60_000); throw new TypeError("Failed to fetch"); });
    expect((await t.coordinator.approve(review.id)).state).toBe("unknown");
    const endedAt = Date.now();
    mintSays("UNSPENT");
    vi.setSystemTime(endedAt + SWAP_SETTLED_MS - 1_000);
    expect((await t.coordinator.reconcile(review.id)).state).toBe("unknown");
    vi.setSystemTime(endedAt + SWAP_SETTLED_MS);
    expect((await t.coordinator.reconcile(review.id)).state).toBe("failed");
    expect(await reserved()).toEqual([]);
  });
});

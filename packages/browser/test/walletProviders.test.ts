import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ONCHAIN_PROVIDER, type PaymentTarget } from "@ghostly/core";
import { STORES, store, transact, wrap } from "../src/shared/idb";
import type { CashuWallet } from "../src/engine/wallet";
import type { LightningProviderDescriptor } from "../src/engine/paymentAdapters/providers/lightning";
import type { OnchainProviderDescriptor } from "../src/engine/paymentAdapters/providers/onchain";
import { CashuMintLightning, cashuMint, CASHU_MINT_SOURCE } from "../src/engine/paymentAdapters/providers/cashuMint";
import { LightningService, type LightningEvents } from "../src/engine/paymentAdapters/providers/lightningService";
import { BitcoinService } from "../src/engine/paymentAdapters/providers/bitcoinService";
import { FakeLightningProvider, FakeOnchainProvider, fakeAddress, fakeInvoice, fakeLightning, fakeOnchain } from "../src/engine/paymentAdapters/providers/testing";
import { NothingSpentError, redact, type ProviderPlatform } from "../src/engine/paymentAdapters/providers/types";
import { offeredIn } from "../src/engine/paymentAdapters/providers/registry";
import { PaymentCoordinator } from "../src/engine/paymentAdapters/coordinator";
import { intentRepository } from "../src/engine/paymentAdapters/persistence";
import { GhostlyNode } from "../src/engine/node";
// covers: wallet.lightning.sources, wallet.lightning.provider-contract, wallet.lightning.cashu-mint.receive, wallet.lightning.cashu-mint.pay, wallet.onchain.sources, payments.chat.reconcile

const settings = async () => wrap<unknown[]>((await store(STORES.settings, "readonly")).getAll());
const keys = async () => (await wrap((await store(STORES.settings, "readonly")).getAllKeys())).map(String).sort();
beforeEach(async () => { await transact([STORES.settings, STORES.intents], (s) => { s[STORES.settings].clear(); s[STORES.intents].clear(); }); });

/** A descriptor around one fake instance, so a test can drive it. */
function lightningDescriptor(fake: FakeLightningProvider, extra: Partial<LightningProviderDescriptor> = {}): LightningProviderDescriptor & { received: unknown[] } {
  const received: unknown[] = [];
  return { ...fakeLightning, received, create: async (settings) => { received.push(settings); return fake; }, ...extra };
}
function service(descriptors: LightningProviderDescriptor[], platform: ProviderPlatform = "web") {
  const events = { changed: vi.fn(), received: vi.fn(), resolved: vi.fn() } satisfies LightningEvents;
  const cashu = { view: async () => ({ balance: 7, mints: [], history: [], feesPaid: 0 }) } as unknown as CashuWallet;
  return { events, lightning: new LightningService(() => [cashuMint, ...descriptors], () => ({ platform, cashu }), events, CASHU_MINT_SOURCE) };
}

describe("the provider registry", () => {
  it("offers a provider only on its platforms and in the mode of its networks", () => {
    const descriptor = { platforms: ["web"] as ProviderPlatform[], networks: ["regtest"] as const };
    expect(offeredIn(descriptor, "web", "testnet")).toBe(true);
    expect(offeredIn(descriptor, "web", "mainnet")).toBe(false);
    expect(offeredIn(descriptor, "extension", "testnet")).toBe(false);
    expect(offeredIn(cashuMint, "desktop", "mainnet") && offeredIn(cashuMint, "extension", "testnet")).toBe(true);
  });
  it("never lets a secret through an error message", () => {
    expect(redact(new Error("bad uri nostr+walletconnect://abc?secret=s3cr3t"), { uri: "nostr+walletconnect://abc?secret=s3cr3t" })).toBe("bad uri •••");
  });
});

describe("active sources, one per wallet mode", () => {
  it("defaults to the Cashu mints, offers what this platform and mode can run, and connects", async () => {
    const { lightning } = service([lightningDescriptor(new FakeLightningProvider())]);
    await lightning.start("mainnet");
    await lightning.ensureReady();
    expect(lightning.view).toMatchObject({ providerId: CASHU_MINT_SOURCE, isDefault: true, status: "ready", network: "bitcoin" });
    expect(lightning.view.offered.map((d) => d.id)).toEqual([CASHU_MINT_SOURCE]);
    await lightning.setMode("testnet");
    await lightning.ensureReady();
    expect(lightning.view.offered.map((d) => d.id)).toEqual([CASHU_MINT_SOURCE, "fake-lightning"]);
    expect(lightning.view).toMatchObject({ mode: "testnet", network: "testnet", status: "ready" });
  });

  it("seals secrets, keeps them out of the view and of plain storage, and hands them back after a restart", async () => {
    const fake = new FakeLightningProvider();
    const descriptor = lightningDescriptor(fake);
    const first = service([descriptor]).lightning;
    await first.start("testnet");
    await first.sources.set("fake-lightning", { alias: "Node A", token: "super-secret-token", behaviour: "settle" });
    expect(first.view).toMatchObject({ providerId: "fake-lightning", status: "ready", config: { alias: "Node A", behaviour: "settle" }, secrets: ["token"] });
    expect(JSON.stringify(first.view)).not.toContain("super-secret-token");
    expect(JSON.stringify(await settings())).not.toContain("super-secret-token");
    // Besides the source, only the last balance it read (to show while it reconnects after a restart).
    expect((await keys()).filter((k) => k !== "lightningSourceSeen-testnet")).toEqual(["lightningSource-testnet"]);

    const again = service([descriptor]).lightning;
    await again.start("testnet");
    await again.ensureReady();
    expect(descriptor.received.at(-1)).toEqual({ config: { alias: "Node A", behaviour: "settle" }, secrets: { token: "super-secret-token" } });
    expect(again.view.status).toBe("ready");
  });

  it("keeps Mainnet and Testnet sources apart: a switch closes one and opens the other", async () => {
    const fake = new FakeLightningProvider();
    const { lightning } = service([lightningDescriptor(fake)]);
    await lightning.start("testnet");
    await lightning.sources.set("fake-lightning", { token: "t", behaviour: "settle" });
    await lightning.setMode("mainnet");
    await lightning.ensureReady();
    expect(fake.closed).toBe(true);
    expect(lightning.view).toMatchObject({ providerId: CASHU_MINT_SOURCE, mode: "mainnet" });
    await lightning.setMode("testnet");
    await lightning.ensureReady();
    expect(lightning.view).toMatchObject({ providerId: "fake-lightning", mode: "testnet", status: "ready" });
    await lightning.sources.clear();
    expect(lightning.view).toMatchObject({ providerId: CASHU_MINT_SOURCE });
    // The source and the last balance it read are both forgotten.
    expect(await keys()).toEqual([]);
  });

  it("refuses a provider whose network belongs to the other mode, a missing field and a provider not offered here", async () => {
    const liar = new FakeLightningProvider();
    liar.info = async () => ({ network: "bitcoin", balance: 0 });
    const { lightning } = service([lightningDescriptor(liar, { networks: ["regtest", "bitcoin"] })]);
    await lightning.start("testnet");
    await expect(lightning.sources.set("fake-lightning", { token: "t" })).rejects.toThrow("real money: switch the wallets to Mainnet");
    expect(liar.closed).toBe(true);
    await expect(lightning.sources.set("fake-lightning", { behaviour: "settle" })).rejects.toThrow("Enter access token");
    const { lightning: web } = service([lightningDescriptor(new FakeLightningProvider(), { platforms: ["desktop"] })]);
    await web.start("testnet");
    await expect(web.sources.set("fake-lightning", { token: "t" })).rejects.toThrow("not available here");
    expect(await keys()).toEqual([]);
  });

  it("says a stored source is gone when this version does not have it, without falling back to another", async () => {
    await transact([STORES.settings], (s) => { s[STORES.settings].put({ providerId: "retired-provider", config: {}, savedAt: 1 }, "lightningSource-mainnet"); });
    const { lightning } = service([]);
    await lightning.start("mainnet");
    await lightning.ensureReady();
    expect(lightning.view).toMatchObject({ providerId: "retired-provider", status: "error" });
    await expect(lightning.createInvoice(10)).rejects.toThrow("not available in this version");
  });
});

describe("Lightning through the active source", () => {
  async function fakeSource(options: ConstructorParameters<typeof FakeLightningProvider>[0] = {}) {
    const fake = new FakeLightningProvider({ settleMs: 60_000, ...options });
    const setup = service([lightningDescriptor(fake)]);
    await setup.lightning.start("testnet");
    await setup.lightning.sources.set("fake-lightning", { token: "t" });
    return { fake, ...setup };
  }

  it("journals an invoice, and tells whoever asked once the source sees it paid", async () => {
    const { fake, lightning, events } = await fakeSource();
    const invoice = await lightning.createInvoice(42, { paymentId: "request-1" });
    expect(await keys()).toContain(`lightningOp-in-${invoice.paymentHash}`);
    fake.markPaid(invoice.paymentHash);
    await lightning.reconcile();
    expect(events.received).toHaveBeenCalledWith(expect.objectContaining({ paymentId: "request-1", providerId: "fake-lightning" }));
    expect(lightning.view.recent[0]).toMatchObject({ direction: "in", state: "paid", amount: 42 });
    await lightning.stop();
  });

  it("pays once: a second pay of the same invoice is refused", async () => {
    const { fake, lightning } = await fakeSource();
    const invoice = fakeInvoice(30, crypto.getRandomValues(new Uint8Array(32)));
    const quote = await lightning.quote(invoice);
    expect(quote).toMatchObject({ amount: 30, feeReserve: 1, source: "fake-lightning" });
    expect(await lightning.pay(quote.quote, { paymentId: "r" })).toBe(true);
    expect(fake.paid).toHaveLength(1);
    await expect(lightning.pay((await lightning.quote(invoice)).quote)).rejects.toThrow("already paid");
    expect(fake.paid).toHaveLength(1);
    await lightning.stop();
  });

  it("a refusal before anything left is a failure that can be retried", async () => {
    const { fake, lightning } = await fakeSource({ behaviour: "refuse" });
    const invoice = fakeInvoice(30, crypto.getRandomValues(new Uint8Array(32)));
    await expect(lightning.pay((await lightning.quote(invoice)).quote)).rejects.toBeInstanceOf(NothingSpentError);
    expect((await lightning.list())[0]).toMatchObject({ direction: "out", state: "failed", error: "No route (fake)" });
    fake.behaviour = "settle";
    expect(await lightning.pay((await lightning.quote(invoice)).quote)).toBe(true);
    await lightning.stop();
  });

  it("a lost answer is unknown: reconciled by asking, never paid again, and the source cannot change meanwhile", async () => {
    const { fake, lightning, events } = await fakeSource({ behaviour: "hang" });
    // The source does not know yet either: the payment stays in flight until it does.
    const answer = fake.paymentStatus.bind(fake);
    let known = false;
    fake.paymentStatus = async (payment) => (known ? answer(payment) : { state: "pending" });
    const invoice = fakeInvoice(30, crypto.getRandomValues(new Uint8Array(32)));
    expect(await lightning.pay((await lightning.quote(invoice)).quote, { paymentId: "r2" })).toBe(false);
    await lightning.reconcile();
    expect((await lightning.list())[0]).toMatchObject({ direction: "out", state: "unknown" });
    expect(events.resolved).not.toHaveBeenCalled();
    await expect(lightning.sources.clear()).rejects.toThrow("has not ended yet");
    await expect(lightning.pay((await lightning.quote(invoice)).quote)).rejects.toThrow("already being paid");
    known = true;
    await lightning.reconcile();
    expect(events.resolved).toHaveBeenCalledWith(expect.objectContaining({ paymentId: "r2" }), true);
    expect(fake.paid).toHaveLength(1);
    await lightning.sources.clear();
    await lightning.stop();
  });

  it("never reconciles a spend still under way: a source that does not know it yet cannot fail it", async () => {
    const { fake, lightning, events } = await fakeSource();
    let finish!: () => void;
    const paying = fake.payInvoice.bind(fake);
    fake.payInvoice = async (invoice, maxFee) => { await new Promise<void>((resolve) => (finish = resolve)); return paying(invoice, maxFee); };
    const invoice = fakeInvoice(30, crypto.getRandomValues(new Uint8Array(32)));
    const paid = lightning.pay((await lightning.quote(invoice)).quote, { paymentId: "r3" });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await lightning.reconcile(); // The fake does not know this payment yet: it would say "failed".
    expect((await lightning.list())[0]).toMatchObject({ state: "sending" });
    finish();
    expect(await paid).toBe(true);
    expect(events.resolved).not.toHaveBeenCalled();
    await lightning.stop();
  });

  it("an interrupted spend is unknown after a restart, not retried", async () => {
    const { lightning } = await fakeSource();
    await transact([STORES.settings], (s) => { s[STORES.settings].put({ direction: "out", providerId: "fake-lightning", mode: "testnet", paymentHash: "ab", invoice: "x", amount: 1, expiresAt: 0, createdAt: 1, state: "sending" }, "lightningOp-out-ab"); });
    await lightning.recover();
    expect((await lightning.list()).find((op) => op.paymentHash === "ab")).toMatchObject({ state: "unknown" });
    await lightning.stop();
  });

  it("in Mainnet, refuses an invoice of a test network", async () => {
    const { lightning } = service([]);
    await lightning.start("mainnet");
    await expect(lightning.quote(fakeInvoice(10, new Uint8Array(32)))).rejects.toThrow("test network");
  });
});

describe("the Cashu mints as a Lightning source", () => {
  const MINT = "https://mint.example";
  const invoice = fakeInvoice(40, new Uint8Array(32).fill(7));
  const wallet = () => ({
    receiveLightning: vi.fn().mockResolvedValue({ quote: "q1", mint: MINT, amount: 40, invoice, createdAt: 0, expiresAt: Date.now() + 60_000 }),
    quoteInvoice: vi.fn().mockResolvedValue({ quote: "m1", mint: MINT, amount: 40, feeReserve: 2 }),
    payQuote: vi.fn().mockResolvedValue(true),
    mintQuoteState: vi.fn().mockResolvedValue("UNPAID"),
    meltQuoteState: vi.fn().mockResolvedValue("PENDING"),
    view: vi.fn().mockResolvedValue({ balance: 99 }),
  });

  it("creates invoices as mint quotes and says where they stand", async () => {
    const cashu = wallet(), provider = new CashuMintLightning(cashu as unknown as CashuWallet, "mainnet");
    expect(await provider.info()).toEqual({ network: "bitcoin", balance: 99 });
    const created = await provider.createInvoice(40);
    expect(created).toMatchObject({ invoice, amount: 40, paymentHash: "07".repeat(32), ref: JSON.stringify({ mint: MINT, quote: "q1" }) });
    expect((await provider.invoiceStatus(created)).state).toBe("open");
    cashu.mintQuoteState.mockResolvedValue("ISSUED");
    expect((await provider.invoiceStatus(created)).state).toBe("paid");
  });

  it("pays the very melt quote whose fee was shown", async () => {
    const cashu = wallet(), provider = new CashuMintLightning(cashu as unknown as CashuWallet, "mainnet");
    expect(await provider.estimateFee(invoice)).toBe(2);
    expect(await provider.payInvoice(invoice, 2, "note")).toMatchObject({ state: "paid" });
    expect(cashu.quoteInvoice).toHaveBeenCalledOnce();
    expect(cashu.payQuote).toHaveBeenCalledWith("m1", MINT, "note");
    cashu.payQuote.mockResolvedValue(false);
    expect(await provider.payInvoice(invoice, 5)).toMatchObject({ state: "pending" });
    expect((await provider.paymentStatus({ invoice, paymentHash: "", ref: JSON.stringify({ mint: MINT, quote: "m1" }) })).state).toBe("pending");
  });

  it("everything the mint refuses is a refusal before anything left, and so is a fee above the cap", async () => {
    const cashu = wallet(), provider = new CashuMintLightning(cashu as unknown as CashuWallet, "testnet");
    cashu.quoteInvoice.mockResolvedValue({ quote: "m1", mint: MINT, amount: 40, feeReserve: 50 });
    await expect(provider.payInvoice(invoice, 10)).rejects.toBeInstanceOf(NothingSpentError);
    expect(cashu.payQuote).not.toHaveBeenCalled();
    cashu.quoteInvoice.mockResolvedValue({ quote: "m1", mint: MINT, amount: 40, feeReserve: 1 });
    cashu.payQuote.mockRejectedValue(new Error("The Lightning payment did not go through. The sats are back in your wallet."));
    await expect(provider.payInvoice(invoice, 10)).rejects.toBeInstanceOf(NothingSpentError);
  });
});

describe("on-chain Bitcoin through the payment coordinator", () => {
  async function bitcoin(fake = new FakeOnchainProvider()) {
    const descriptor: OnchainProviderDescriptor = { ...fakeOnchain, create: async () => fake };
    const service = new BitcoinService(() => [descriptor], () => ({ platform: "web", cashu: {} as CashuWallet }), vi.fn());
    await service.start("testnet");
    return { fake, service, coordinator: new PaymentCoordinator(intentRepository, [service.adapter]) };
  }
  const target = (address: string): PaymentTarget => ({ method: "bitcoin", network: "regtest", provider: ONCHAIN_PROVIDER, asset: "BTC", unit: "sat", address, expiresAt: Date.now() + 60_000 });

  it("says there is no source until one is set up", async () => {
    const { service, coordinator } = await bitcoin();
    expect(service.view).toMatchObject({ status: "none", history: [] });
    await expect(coordinator.prepare(target(fakeAddress()), 1_000, 1_000, { payee: "x" })).rejects.toThrow("No Bitcoin source is set up");
  });

  it("reviews a signed transaction, broadcasts exactly it once approved, and settles it once confirmed", async () => {
    const { fake, service, coordinator } = await bitcoin();
    await service.sources.set("fake-onchain", { token: "t" });
    expect(await service.receiveAddress()).toMatch(/^bcrt1/);
    const review = await coordinator.prepare(target(fakeAddress()), 1_000, 1_000, { payee: "x" });
    expect(review).toMatchObject({ state: "pending", fee: 282 });
    expect(fake.broadcasts).toEqual([]);
    const approved = await coordinator.approve(review.id);
    expect(approved).toMatchObject({ state: "submitted" });
    expect(fake.broadcasts).toEqual([approved.txid]);
    expect(await coordinator.reconcile(review.id)).toMatchObject({ state: "settled", txid: approved.txid });
    await expect(service.sources.clear()).resolves.toBeUndefined();
  });

  it("a refused broadcast fails cleanly; a lost answer is unknown and reconciled with the same transaction", async () => {
    const { fake, service, coordinator } = await bitcoin(new FakeOnchainProvider({ behaviour: "refuse" }));
    await service.sources.set("fake-onchain", { token: "t" });
    const refused = await coordinator.prepare(target(fakeAddress()), 1_000, 1_000, { payee: "x" });
    expect(await coordinator.approve(refused.id)).toMatchObject({ state: "failed" });
    fake.behaviour = "hang";
    const lost = await coordinator.prepare(target(fakeAddress()), 1_000, 1_000, { payee: "x" });
    expect(await coordinator.approve(lost.id)).toMatchObject({ state: "unknown" });
    await expect(service.sources.clear()).rejects.toThrow("not confirmed or cancelled");
    expect(await coordinator.reconcile(lost.id)).toMatchObject({ state: "settled" });
    expect(new Set(fake.broadcasts).size).toBe(1);
  });

  it("keeps the signal of a source it just set; replacing it aborts only the old one's", async () => {
    const signals: AbortSignal[] = [];
    const descriptor: OnchainProviderDescriptor = { ...fakeOnchain, create: async (_settings, host) => { signals.push(host.signal); return new FakeOnchainProvider(); } };
    const service = new BitcoinService(() => [descriptor], () => ({ platform: "web", cashu: {} as CashuWallet }), vi.fn());
    await service.start("testnet");
    await service.sources.set("fake-onchain", { token: "a" });
    expect(signals[0].aborted).toBe(false);
    await service.sources.set("fake-onchain", { token: "b" });
    expect([signals[0].aborted, signals[1].aborted]).toEqual([true, false]);
    await service.stop();
    expect(signals[1].aborted).toBe(true);
  });

  it("gives back the coins a cancelled review reserved, and refuses another network's address", async () => {
    const { fake, service, coordinator } = await bitcoin();
    await service.sources.set("fake-onchain", { token: "t" });
    const review = await coordinator.prepare(target(fakeAddress()), 1_000, 1_000, { payee: "x" });
    await coordinator.cancel(review.id);
    expect(fake.released).toHaveLength(1);
    await expect(coordinator.prepare({ ...target("tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7"), network: "signet" }, 1_000, 1_000, { payee: "x" })).rejects.toThrow("not signet");
  });
});

describe("the engine", () => {
  it("routes the Lightning card through the mode's source, and each mode keeps its own", async () => {
    const fake = new FakeLightningProvider({ settleMs: 60_000 });
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: false, providers: { lightning: [cashuMint, lightningDescriptor(fake)], onchain: [] } });
    vi.spyOn(node["wallet"], "view").mockImplementation(async () => ({ mints: [], balance: 0, history: [], feesPaid: 0 }));
    const receive = vi.spyOn(node["wallet"], "receiveLightning");
    await node["lightning"].start("mainnet");
    await node.walletSetMode({ mode: "testnet" });
    await node.lightningSetSource({ providerId: "fake-lightning", values: { token: "t" } });
    const created = await node.walletReceiveLightning({ amount: 12 });
    expect(created).toMatchObject({ source: "fake-lightning" });
    expect(created.invoice).toMatch(/^lnbcrt/);
    expect(receive).not.toHaveBeenCalled();
    expect(node.getState().wallet.lightning).toMatchObject({ providerId: "fake-lightning", status: "ready" });

    const quote = await node.walletQuoteInvoice({ invoice: fakeInvoice(5, crypto.getRandomValues(new Uint8Array(32))) });
    expect(await node.walletPayQuote({ quote: quote.quote, mint: quote.mint })).toEqual({ paid: true });

    await node.walletSetMode({ mode: "mainnet" });
    await vi.waitFor(() => expect(node.getState().wallet.lightning).toMatchObject({ mode: "mainnet", providerId: CASHU_MINT_SOURCE }));
    expect(node.getState().wallet.bitcoin).toMatchObject({ status: "none" });
    await node.shutdown();
  });
});

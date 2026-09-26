import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ONCHAIN_PROVIDER, createIdentity, type PaymentReview, type PaymentTarget } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import { TEST_MINT } from "../src/shared/mints";
import { intentRepository } from "../src/engine/paymentAdapters/persistence";
import { cashuMint, CASHU_MINT_SOURCE } from "../src/engine/paymentAdapters/providers/cashuMint";
import { FakeLightningProvider, FakeOnchainProvider, fakeAddress, fakeInvoice, fakeLightning, fakeOnchain } from "../src/engine/paymentAdapters/providers/testing";
import type { StoredLink, StoredPayment } from "../src/shared/types";
// covers: payments.chat.review, payments.chat.method-off, payments.chat.reconcile, wallet.mode, wallet.onchain.sources, wallet.cashu.mint.manage, wallet.cashu.export

/** A connected contact, as far as the engine's payment paths look at it. */
function stubLink(overrides: Record<string, unknown> = {}) {
  return {
    requirePaymentSupport: vi.fn(async () => {}),
    allowsPayment: vi.fn(() => true),
    paymentEnabled: vi.fn(() => true),
    supportsUsdtPayments: true, supportsArkPayments: true, supportsBarkPayments: true, supportsBitcoinPayments: true,
    isDataLinkOpen: true,
    sendPayment: vi.fn(async () => {}),
    sendPaymentRequest: vi.fn(async () => {}),
    sendPaymentAsk: vi.fn(async () => {}),
    sendPaymentResult: vi.fn(),
    stop: vi.fn(async () => {}),
    ...overrides,
  };
}

function addChat(node: GhostlyNode, link: ReturnType<typeof stubLink> | null, stored: Partial<StoredLink> = {}) {
  const row: StoredLink = { id: `chat-${crypto.randomUUID().slice(0, 8)}`, profile: "paired-chat/1", createdAt: 1, seedB64: createIdentity().seedB64,
    encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64, ...stored };
  node["links"].set(row.id, { stored: row, myPubKeyZ32: "me", link: link as never, status: "online", dataLink: "open",
    presence: { online: true, lastPacketAt: 0, services: null }, lastMessageAt: 0, peerAck: 0, lastSyncAt: 0,
    poll: { polling: false, nextAt: 0, interval: 0 }, files: { receivedBytes: 0, wireIds: new Set(), incoming: new Map() } });
  return row;
}

function engine(options: { lightning?: FakeLightningProvider; onchain?: FakeOnchainProvider } = {}) {
  const lightning = options.lightning ?? new FakeLightningProvider({ settleMs: 60_000 });
  const onchain = options.onchain ?? new FakeOnchainProvider();
  const events = { onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: vi.fn() };
  const node = new GhostlyNode(events, { automaticWallets: false, providers: {
    lightning: [cashuMint, { ...fakeLightning, create: async () => lightning }],
    onchain: [{ ...fakeOnchain, create: async () => onchain }],
  } });
  const view = vi.spyOn(node["wallet"], "view").mockImplementation(async () => ({ mints: [], balance: 0, history: [], feesPaid: 0 }));
  return { node, events, lightning, onchain, view };
}

/** A Testnet engine with the fake on-chain wallet as its Bitcoin source. */
async function bitcoinEngine(onchain = new FakeOnchainProvider()) {
  const setup = engine({ onchain });
  await setup.node.bitcoinSetSource({ providerId: "fake-onchain", values: { token: "chain-secret-token" }, network: "testnet" });
  return setup;
}

const bitcoinTarget = (address = fakeAddress()): PaymentTarget => ({ method: "bitcoin", network: "regtest", provider: ONCHAIN_PROVIDER, asset: "BTC", unit: "sat", address, expiresAt: Date.now() + 60_000 });

function savedReview(overrides: Partial<PaymentReview> = {}): PaymentReview {
  return { id: crypto.randomUUID(), linkId: "chat", payee: "peer", amount: 10, fee: 2, feeCap: 2, state: "pending", createdAt: Date.now(),
    expiresAt: Date.now() + 60_000, method: "cashu", network: "cashu-test", provider: TEST_MINT, address: "request", asset: "BTC", unit: "sat", ...overrides } as PaymentReview;
}

const nodes: GhostlyNode[] = [];
beforeEach(async () => {
  await transact([STORES.settings, STORES.intents, STORES.payments], (s) => { s[STORES.settings].clear(); s[STORES.intents].clear(); s[STORES.payments].clear(); });
});
afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown(); vi.restoreAllMocks(); });
const track = <T extends { node: GhostlyNode }>(setup: T) => { nodes.push(setup.node); return setup; };

describe("reviewing and approving a payment", () => {
  it("spends nothing before approval, spends once however many times it is approved, and settles once confirmed", async () => {
    const { node, onchain } = track(await bitcoinEngine());
    const review = await node.preparePayment({ target: bitcoinTarget(), amount: 1_000, feeCap: 1_000, payee: "someone", memo: `  ${"m".repeat(200)}  ` });
    expect(review).toMatchObject({ state: "pending", amount: 1_000, fee: 282 });
    expect(review.memo).toHaveLength(140);
    expect(onchain.broadcasts, "a review spends nothing").toEqual([]);

    const [first, second] = await Promise.all([node.approvePayment({ id: review.id }), node.approvePayment({ id: review.id })]);
    expect(first.state).toBe("submitted");
    expect(second).toEqual(first);
    await expect(node.approvePayment({ id: review.id })).rejects.toThrow("cannot be submitted again");
    expect(onchain.broadcasts).toHaveLength(1);

    expect(await node.reconcilePayment({ id: review.id })).toMatchObject({ state: "settled", txid: first.txid });
    expect(onchain.broadcasts).toHaveLength(1);
    await vi.waitFor(() => expect(node.getState().wallet.intents?.find((r) => r.id === review.id)).toMatchObject({ state: "settled" }));
  });

  it("an answer lost on the way is unknown: it is only reconciled, never broadcast again", async () => {
    const { node, onchain } = track(await bitcoinEngine(new FakeOnchainProvider({ behaviour: "hang" })));
    const review = await node.preparePayment({ target: bitcoinTarget(), amount: 1_000, feeCap: 1_000, payee: "someone" });
    expect(await node.approvePayment({ id: review.id })).toMatchObject({ state: "unknown" });
    await expect(node.approvePayment({ id: review.id })).rejects.toThrow("cannot be submitted again");
    expect(await node.reconcilePayment({ id: review.id })).toMatchObject({ state: "settled" });
    expect(new Set(onchain.broadcasts).size).toBe(1);
  });

  it("the payment poll reconciles an unknown outcome once its wallet is there, and leaves the others alone", async () => {
    const { node, onchain } = track(await bitcoinEngine(new FakeOnchainProvider({ behaviour: "hang" })));
    const review = await node.preparePayment({ target: bitcoinTarget(), amount: 1_000, feeCap: 1_000, payee: "someone" });
    await node.approvePayment({ id: review.id });
    // An Ark payment whose wallet is not open: nothing can tell its outcome, so it is not touched.
    const ark = savedReview({ method: "arkade", state: "unknown" } as Partial<PaymentReview>);
    await intentRepository.put({ review: ark, prepared: {} });
    const reconcile = vi.spyOn(node, "reconcilePayment");
    await node["pollPaymentStatus"]();
    expect(reconcile.mock.calls.map(([p]) => p.id)).toEqual([review.id]);
    expect((await intentRepository.get(review.id))?.review.state).toBe("settled");
    expect((await intentRepository.get(ark.id))?.review.state).toBe("unknown");
    expect(onchain.broadcasts).toHaveLength(1);
  });

  it("a Testnet source stays Testnet's: only a Testnet payment goes through it", async () => {
    const { node, onchain } = track(await bitcoinEngine());
    // Mainnet has no source; the Testnet one is there, connected.
    expect(node.getState().wallet.bitcoin).toMatchObject({ status: "none", mode: "mainnet" });
    expect(node.getState().wallet.networks?.testnet.bitcoin).toMatchObject({ providerId: "fake-onchain", status: "ready", mode: "testnet" });
    expect(node.getState().wallet.wallets?.map((w) => w.id)).toEqual(["bitcoin:testnet"]);
    // A Testnet address is paid by the Testnet source: the target's chain says which, not the page.
    const review = await node.preparePayment({ target: bitcoinTarget(), amount: 1_000, feeCap: 1_000, payee: "someone" });
    expect(review).toMatchObject({ method: "bitcoin", network: "regtest" });
    // A card of the other network never pays it, and a Mainnet address has no Mainnet source to go through.
    await expect(node.preparePayment({ target: bitcoinTarget(), amount: 1_000, feeCap: 1_000, payee: "someone", network: "mainnet" })).rejects.toThrow("a Mainnet wallet never pays it");
    const mainnet: PaymentTarget = { ...bitcoinTarget(), network: "bitcoin", address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" };
    await expect(node.preparePayment({ target: mainnet, amount: 1_000, feeCap: 1_000, payee: "someone" })).rejects.toThrow("No Bitcoin source is set up");
    expect(await node.bitcoinReceiveAddress({ network: "testnet" })).toMatch(/^bcrt1/);
    expect(onchain.broadcasts).toEqual([]);
  });

  it("the source's secret never reaches the state the pages see", async () => {
    const { node } = track(await bitcoinEngine());
    await node.lightningSetSource({ providerId: "fake-lightning", values: { token: "lightning-secret-token" }, network: "testnet" });
    const state = JSON.stringify(node.getState());
    expect(state).not.toContain("chain-secret-token");
    expect(state).not.toContain("lightning-secret-token");
    expect(node.getState().wallet.networks?.testnet.bitcoin).toMatchObject({ providerId: "fake-onchain", status: "ready" });
    await node.bitcoinRefresh({ network: "testnet" });
    await node.bitcoinClearSource({ network: "testnet" });
    expect(node.getState().wallet.networks?.testnet.bitcoin).toMatchObject({ status: "none" });
  });

  it("without its wallet, an unknown outcome stays unknown: nothing is failed and nothing is sent again", async () => {
    const { node } = track(engine());
    for (const method of ["arkade", "bark", "usdt", "cashu"] as const) {
      const review = savedReview({ method, state: "unknown" } as Partial<PaymentReview>);
      await intentRepository.put({ review, prepared: {} });
      expect(await node.reconcilePayment({ id: review.id }), method).toMatchObject({ state: "unknown", error: expect.stringContaining("No second payment was sent") });
    }
  });
});

describe("a payment in a chat", () => {
  it("refuses while the contact is offline, and each way of paying the chat or the contact does not take", async () => {
    const { node } = track(engine());
    const offline = addChat(node, null);
    await expect(node.preparePayment({ linkId: offline.id, target: bitcoinTarget(), amount: 1_000, feeCap: 1_000, payee: "x" })).rejects.toThrow("offline");
    const cases: [Record<string, unknown>, PaymentTarget["method"], string][] = [
      [{ allowsPayment: vi.fn(() => false) }, "cashu", "Cashu is off in this chat"],
      [{ supportsUsdtPayments: false }, "usdt", "does not support USDT"],
      [{ supportsArkPayments: false }, "arkade", "does not support Ark"],
      [{ supportsBarkPayments: false }, "bark", "does not support Bark"],
      [{ supportsBitcoinPayments: false }, "bitcoin", "does not take on-chain Bitcoin"],
    ];
    for (const [link, method, error] of cases) {
      const chat = addChat(node, stubLink(link));
      await expect(node.preparePayment({ linkId: chat.id, target: { ...bitcoinTarget(), method } as PaymentTarget, amount: 1_000, feeCap: 1_000, payee: "x" }), method).rejects.toThrow(error);
    }
    expect(await intentRepository.list()).toEqual([]);
  });

  it("pays only the contact the chat is with, and ecash only against one of its requests", async () => {
    const { node } = track(engine());
    const chat = addChat(node, stubLink());
    const cashu = (address: string): PaymentTarget => ({ method: "cashu", network: "cashu-test", provider: TEST_MINT, asset: "BTC", unit: "sat", address } as PaymentTarget);
    await expect(node.preparePayment({ linkId: chat.id, target: bitcoinTarget(), amount: 1_000, feeCap: 1_000, payee: "x" })).rejects.toThrow("Destination does not match");
    await expect(node.preparePayment({ linkId: chat.id, target: cashu("someone-else"), amount: 1_000, feeCap: 1_000, payee: "x" })).rejects.toThrow("Destination does not match");
    await expect(node.preparePayment({ target: cashu(chat.peerPubKeyZ32), amount: 1_000, feeCap: 1_000, payee: "x" })).rejects.toThrow("Select a Cashu chat request first");
  });

  it("a review must match the authenticated request it pays, and a request is paid once", async () => {
    const { node, onchain } = track(await bitcoinEngine());
    const link = stubLink();
    const chat = addChat(node, link);
    const target = bitcoinTarget();
    const request: StoredPayment = { id: "req-1", linkId: chat.id, kind: "request", direction: "in", amount: 1_000, unit: "sat", state: "pending", createdAt: 1, target };
    node["desk"]["payments"].set(request.id, request);
    const pay = (overrides: Record<string, unknown> = {}) => node.preparePayment({ linkId: chat.id, requestId: request.id, target, amount: 1_000, feeCap: 1_000, payee: "forged", ...overrides });

    await expect(pay({ amount: 999 })).rejects.toThrow("does not match the authenticated request");
    await expect(pay({ requestId: "unknown" })).rejects.toThrow("does not match the authenticated request");
    await expect(pay({ target: bitcoinTarget() })).rejects.toThrow("Selected method or mint does not match");
    const review = await pay();
    expect(review.payee, "the payee is the chat's contact, not what the page said").toBe(chat.peerPubKeyZ32);
    node["desk"]["payments"].set("paid", { id: "paid", linkId: chat.id, kind: "payment", direction: "out", amount: 1_000, unit: "sat", state: "pending", createdAt: 2, requestId: request.id });
    await expect(pay()).rejects.toThrow("already has a payment");
    node["desk"]["payments"].delete("paid");

    const approved = await node.approvePayment({ id: review.id });
    expect(approved.state).toBe("submitted");
    expect(onchain.broadcasts).toEqual([approved.txid]);
    // The contact is told which transaction paid it, and the chat shows the payment.
    expect(link.sendPayment).toHaveBeenCalledWith(expect.objectContaining({ id: review.id, requestId: request.id }));
    expect(node.getState().payments[review.id]).toMatchObject({ kind: "payment", direction: "out", txid: approved.txid });
  });

  it("approval waits for the contact to be back and to still take that way of paying; the review stays", async () => {
    const { node } = track(engine());
    const approve = vi.spyOn(node["paymentCoordinator"], "approve");
    const cases: [ReturnType<typeof stubLink> | null, PaymentReview["method"], string][] = [
      [null, "cashu", "Reconnect the data link"],
      [stubLink({ supportsArkPayments: false }), "arkade", "Reconnect the data link"],
      [stubLink({ supportsUsdtPayments: false }), "usdt", "supporting USDT"],
      [stubLink({ supportsBarkPayments: false }), "bark", "supporting Bark"],
      [stubLink({ supportsBitcoinPayments: false }), "bitcoin", "taking on-chain Bitcoin"],
      [stubLink({ allowsPayment: vi.fn(() => false) }), "cashu", "Cashu is off in this chat"],
    ];
    for (const [link, method, error] of cases) {
      const chat = addChat(node, link);
      const review = savedReview({ linkId: chat.id, method } as Partial<PaymentReview>);
      await intentRepository.put({ review, prepared: {} });
      await expect(node.approvePayment({ id: review.id }), method).rejects.toThrow(error);
      expect((await intentRepository.get(review.id))?.review.state).toBe("pending");
    }
    const chat = addChat(node, stubLink());
    const unpaidRequest = savedReview({ linkId: chat.id, requestId: "gone" });
    await intentRepository.put({ review: unpaidRequest, prepared: {} });
    await expect(node.approvePayment({ id: unpaidRequest.id })).rejects.toThrow("no longer awaiting payment");
    expect(approve).not.toHaveBeenCalled();
  });
});

describe("sending, requesting and asking", () => {
  it("ecash is never held for an away contact; with the contact there it goes to the desk", async () => {
    const { node } = track(engine());
    const chat = addChat(node, stubLink({ isDataLinkOpen: false }));
    const canHold = vi.spyOn(node["hold"], "canHold").mockReturnValue(true);
    const send = vi.spyOn(node["desk"], "send").mockResolvedValue({ paymentId: "p" });
    expect(() => node.sendPayment({ linkId: chat.id, amount: 5, timestamp: 1 })).toThrow("not held for an away contact");
    expect(send).not.toHaveBeenCalled();
    canHold.mockReturnValue(false);
    await expect(node.sendPayment({ linkId: chat.id, amount: 5, timestamp: 1 })).resolves.toEqual({ paymentId: "p" });
  });

  it("a request passes only what the person chose: a page cannot slip in the id of an ask", async () => {
    const { node } = track(engine());
    const request = vi.spyOn(node["desk"], "request").mockResolvedValue({ paymentId: "r" });
    await node.requestPayment({ linkId: "chat", amount: 5, memo: "m", timestamp: 1, method: "bark", ask: "forged-ask" } as never);
    expect(request).toHaveBeenCalledWith({ linkId: "chat", amount: 5, memo: "m", timestamp: 1, method: "bark", network: "mainnet" });
    await node.requestPayment({ linkId: "chat", amount: 5, timestamp: 2, method: "bark", network: "testnet" });
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ timestamp: 2, network: "testnet" }));
  });

  it("only Ark, Bark, Spark, USDT, on-chain Bitcoin and Fedimint are paid by asking, and only a contact taking them is asked", async () => {
    const { node } = track(engine());
    const link = stubLink({ supportsBarkPayments: false, supportsSparkPayments: false });
    const chat = addChat(node, link);
    expect(() => node.askToPay({ linkId: chat.id, amount: 5, method: "cashu" as never, timestamp: 1 })).toThrow("Only Ark, Bark, Spark, USDT, on-chain Bitcoin and Fedimint");
    await expect(node.askToPay({ linkId: chat.id, amount: 5, method: "bark", timestamp: 1 })).rejects.toThrow("does not accept Bark");
    await expect(node.askToPay({ linkId: chat.id, amount: 5, method: "spark", timestamp: 1 })).rejects.toThrow("does not accept Spark");
    expect(await node.askToPay({ linkId: chat.id, amount: 5, method: "arkade", timestamp: 1 })).toHaveProperty("askId");
    expect(link.sendPaymentAsk).toHaveBeenCalledOnce();
  });

  it("paying or reclaiming what is not there is refused", async () => {
    const { node } = track(engine());
    const chat = addChat(node, stubLink());
    await expect(node.payRequest({ linkId: chat.id, paymentId: "nope" })).rejects.toThrow("Unknown payment request");
    await expect(node.reclaimPayment({ paymentId: "nope" })).rejects.toThrow("Nothing to reclaim");
  });

  it("the ecash of a sent payment never reaches the state the pages see", async () => {
    const { node } = track(engine());
    node["desk"]["payments"].set("sent", { id: "sent", linkId: "chat", kind: "payment", direction: "out", amount: 5, unit: "sat", state: "pending", createdAt: 1, token: "cashuBsecret-bearer-token" });
    expect(node.getState().payments.sent).toMatchObject({ amount: 5 });
    expect(JSON.stringify(node.getState())).not.toContain("cashuBsecret-bearer-token");
  });

  it("a refused reviewed payment is marked failed with the sats back, only while it was still in flight", async () => {
    const { node } = track(engine());
    const submitted = savedReview({ state: "submitted" }), settled = savedReview({ state: "settled" });
    for (const review of [submitted, settled]) await intentRepository.put({ review, prepared: {} });
    const host = node["desk"]["host"] as { onReviewedPaymentRefused(id: string, reason: string): Promise<void> };
    await host.onReviewedPaymentRefused(submitted.id, "unknown mint");
    await host.onReviewedPaymentRefused(settled.id, "unknown mint");
    expect((await intentRepository.get(submitted.id))?.review).toMatchObject({ state: "failed", error: "Refused: unknown mint. The sats came back." });
    expect((await intentRepository.get(settled.id))?.review.state).toBe("settled");
  });
});

describe("the Cashu wallet and Lightning", () => {
  it("adds a mint once, first when asked to, and keeps the list in the saved settings", async () => {
    const { node } = track(engine());
    vi.spyOn(node["wallet"], "checkMint").mockImplementation(async (url: string) => ({ url: url.replace(/\/$/, ""), name: url }));
    await node.walletAddMint({ url: "https://a.example/" });
    await node.walletAddMint({ url: "https://b.example" });
    await node.walletAddMint({ url: "https://a.example" });
    expect(node["settings"].mints).toEqual(["https://a.example", "https://b.example"]);
    await node.walletAddMint({ url: "https://b.example", primary: true });
    expect((await db.getSettings()).mints).toEqual(["https://b.example", "https://a.example"]);
    await node.walletSetPrimaryMint({ url: "https://unknown.example" });
    expect(node["settings"].mints).toEqual(["https://b.example", "https://a.example"]);
    await node.walletSetPrimaryMint({ url: "https://a.example" });
    expect(node["settings"].mints).toEqual(["https://a.example", "https://b.example"]);
  });

  it("never removes a mint that still holds sats", async () => {
    const { node } = track(engine());
    node["settings"].mints = ["https://a.example", "https://b.example"];
    const balance = vi.spyOn(node["wallet"], "balanceAt").mockResolvedValue(21);
    await expect(node.walletRemoveMint({ url: "https://a.example" })).rejects.toThrow("Move your sats out");
    expect(node["settings"].mints).toHaveLength(2);
    balance.mockResolvedValue(0);
    await node.walletRemoveMint({ url: "https://a.example" });
    expect((await db.getSettings()).mints).toEqual(["https://b.example"]);
  });

  it("the Cashu card goes to the mints; everything else to the Lightning source of its network", async () => {
    const { node, lightning } = track(engine());
    await node.lightningSetSource({ providerId: "fake-lightning", values: { token: "t" }, network: "testnet" });
    const invoice = fakeInvoice(9, new Uint8Array(32).fill(3));
    vi.spyOn(node["wallet"], "receiveLightning").mockResolvedValue({ quote: "q", mint: TEST_MINT, amount: 9, invoice, createdAt: 0, expiresAt: 5 } as never);
    const cashuQuote = vi.spyOn(node["wallet"], "quoteInvoice").mockResolvedValue({ quote: "melt", mint: TEST_MINT, amount: 9, feeReserve: 1 });
    const cashuPay = vi.spyOn(node["wallet"], "payQuote").mockResolvedValue(true);

    expect(await node.walletReceiveLightning({ amount: 9, via: "cashu", network: "testnet" })).toEqual({ quote: "q", invoice, expiresAt: 5, source: CASHU_MINT_SOURCE });
    expect(lightning.invoices.size).toBe(0);
    expect(await node.walletReceiveLightning({ amount: 9, network: "testnet" })).toMatchObject({ source: "fake-lightning" });
    expect(lightning.invoices.size).toBe(1);

    expect(await node.walletQuoteInvoice({ invoice, via: "cashu", network: "testnet" })).toMatchObject({ quote: "melt" });
    expect(await node.walletPayQuote({ quote: "melt", mint: TEST_MINT, network: "testnet" })).toEqual({ paid: true });
    expect(cashuQuote).toHaveBeenCalledOnce();
    expect(cashuPay).toHaveBeenCalledWith("melt", TEST_MINT, undefined);
    expect(lightning.paid).toEqual([]);

    await node.lightningRefresh({ network: "testnet" });
    await node.lightningClearSource({ network: "testnet" });
    expect(node.getState().wallet.networks?.testnet.lightning).toMatchObject({ providerId: CASHU_MINT_SOURCE });
  });

  it("keeps each network's history apart, counts test sats waiting while the page shows Mainnet, and chimes once per new receipt", async () => {
    const { node, view, events } = track(engine());
    node["settings"].mints = ["https://real.example", TEST_MINT];
    const tx = (id: string, mint: string, kind = "ecash-in") => ({ id, mint, kind, amount: 10, fee: 1, timestamp: Date.now() + 1_000 });
    const history = [tx("old", "https://real.example"), tx("test", TEST_MINT)];
    view.mockImplementation(async (network) => ({ mints: [], balance: network === "testnet" ? 50 : 1_000, history: [...history], feesPaid: 0 }) as never);
    await node["refreshWallet"]();
    expect(node.getState().wallet).toMatchObject({ feesPaid: 1, balance: 1_000 });
    expect(node.getState().wallet.history.map((t) => t.id)).toEqual(["old"]);
    expect(node.getState().wallet.networks?.testnet).toMatchObject({ balance: 50, feesPaid: 1 });
    expect(node.getState().wallet.networks?.testnet.history.map((t) => t.id)).toEqual(["test"]);
    expect(events.onAttention, "what was there before is not news").not.toHaveBeenCalled();

    // News from either network chimes: a test payment arriving is news too.
    history.push(tx("new", "https://real.example", "lightning-in"), tx("paid", "https://real.example", "lightning-out"), tx("test-in", TEST_MINT));
    await node["refreshWallet"]();
    await node["refreshWallet"]();
    expect(events.onAttention.mock.calls.map(([e]) => e.type).sort()).toEqual(["coin", "coin", "confirmed"]);
  });

  it("a wallet backup that does not restore connects nothing; one that does, connects", async () => {
    const { node } = track(engine());
    for (const [kind, restore] of [["ark", node.arkRestoreBackup], ["bark", node.barkRestoreBackup], ["usdt", node.usdtRestoreBackup]] as const) {
      const wallet = node[`${kind}Wallets` as "arkWallets"].mainnet;
      const restored = vi.spyOn(wallet, "restoreBackup").mockRejectedValueOnce(new Error("Wrong password")).mockResolvedValueOnce(undefined as never);
      const ready = vi.spyOn(wallet, "ensureReady").mockResolvedValue(undefined as never);
      await expect(restore.call(node, { text: "backup", password: "bad" }), kind).rejects.toThrow("Wrong password");
      expect(ready).not.toHaveBeenCalled();
      await restore.call(node, { text: "backup", password: "good" });
      expect(restored).toHaveBeenLastCalledWith("backup", "good");
      expect(ready).toHaveBeenCalledOnce();
    }
  });

  it("the exported ecash is handed to the caller only, never put in the state", async () => {
    const { node } = track(engine());
    vi.spyOn(node["wallet"], "exportTokens").mockResolvedValue([{ mint: TEST_MINT, token: "cashuBexported-secret", amount: 3 }]);
    expect(await node.walletExport()).toEqual([{ mint: TEST_MINT, token: "cashuBexported-secret", amount: 3 }]);
    await node["refreshWallet"]();
    expect(JSON.stringify(node.getState())).not.toContain("cashuBexported-secret");
  });
});

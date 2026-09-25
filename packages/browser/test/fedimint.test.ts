import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENDPOINT, PaymentPreflightError, parseFedimintRequestPayload, validatePaymentTarget, type GhostLink, type PaymentReview } from "@ghostly/core";
import { FedimintAdapter } from "../src/engine/paymentAdapters/fedimint";
import { FEDIMINT_MAINNET_UNAVAILABLE, FedimintWallet, fedimintTiming, historyEntry, normalizeInvite } from "../src/engine/paymentAdapters/fedimintWallet";
import { federationInfo } from "../src/engine/paymentAdapters/fedimintSdk";
import { PaymentCoordinator } from "../src/engine/paymentAdapters/coordinator";
import { intentRepository } from "../src/engine/paymentAdapters/persistence";
import { FedimintLightning, fedimint as fedimintDescriptor } from "../src/engine/paymentAdapters/providers/fedimint";
import { isNothingSpentError, providerDescriptorProblems } from "../src/engine/paymentAdapters/providers/types";
import { fakeInvoice } from "../src/engine/paymentAdapters/providers/testing";
import { PaymentDesk } from "../src/engine/payments";
import type { CashuWallet } from "../src/engine/wallet";
import { STORES, openDb, store, transact, wrap } from "../src/shared/idb";
import type { StoredPayment } from "../src/shared/types";
import { FakeFedimintSdk, type FakeFederation } from "./helpers/fakeFedimint";
// covers: wallet.fedimint.join, wallet.fedimint.notes, wallet.fedimint.backup, wallet.fedimint.mainnet-off, payments.fedimint.chat, payments.fedimint.lightning, wallet.lightning.fedimint

fedimintTiming.pollMs = 20;
let fake: FakeFedimintSdk;
let federation: FakeFederation;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function wallet(mode: "mainnet" | "testnet" = "testnet", events = { changed: vi.fn(), received: vi.fn() }) {
  const w = new FedimintWallet(events, fake.sdk());
  await w.start();
  await w.setMode(mode);
  return w;
}
/** A joined wallet with `sats` in the federation (paid in over Lightning). */
async function funded(sats: number, f = federation) {
  const w = await wallet();
  await w.join(f.invite);
  if (sats) { const { invoice } = await w.createInvoice(f.id, sats); f.payInvoice(invoice); }
  return w;
}

beforeEach(async () => {
  fake = new FakeFedimintSdk();
  federation = fake.federation({ name: "Regtest federation" });
  await openDb();
  await transact([STORES.settings, STORES.intents, STORES.payments], (s) => { s[STORES.settings].clear(); s[STORES.intents].clear(); s[STORES.payments].clear(); });
});

describe("the Fedimint wallet", () => {
  it("shows a federation before joining it, and joins it: name, guardians, version, network, balance", async () => {
    const w = await wallet();
    const preview = await w.preview(federation.invite);
    expect(preview).toMatchObject({ federationId: federation.id, name: "Regtest federation", consensusVersion: "2.1", network: "regtest", guardians: [{ name: "g0" }] });
    expect(fake.databases.size, "previewing joins nothing").toBe(0);
    const joined = await w.join(` ${federation.invite.toUpperCase()} `);
    expect(joined).toMatchObject({ id: federation.id, status: "ready", lightning: true, balance: 0 });
    await expect(w.join(federation.invite)).rejects.toThrow("already joined");
    const { invoice } = await w.createInvoice(federation.id, 2_500);
    federation.payInvoice(invoice);
    await w.refresh();
    expect(w.view).toMatchObject({ balance: 2_500, federations: [{ balance: 2_500 }] });
    expect(w.view.history[0]).toMatchObject({ kind: "lightning-in", amount: 2_500, state: "done" });
  });

  it("refuses what is not an invite code, a federation of the other mode's network, and one without ecash", async () => {
    const w = await wallet();
    await expect(w.preview("lnbc1xyz")).rejects.toThrow("starts with fed1");
    const real = fake.federation({ network: "bitcoin" });
    await expect(w.join(real.invite)).rejects.toThrow("real bitcoin");
    const unknown = fake.federation({ network: undefined });
    await expect(w.join(unknown.invite)).rejects.toThrow("which Bitcoin network");
    const noMint = fake.federation({ modules: ["ln", "wallet"] });
    await expect(w.join(noMint.invite)).rejects.toThrow("no ecash module");
    expect(w.view.federations).toEqual([]);
  });

  it("joins nothing on Mainnet yet, and says so", async () => {
    const w = await wallet("mainnet");
    expect(w.view.unavailable).toBe(FEDIMINT_MAINNET_UNAVAILABLE);
    await expect(w.join(fake.federation({ network: "bitcoin" }).invite)).rejects.toThrow("not available yet");
  });

  it("keeps each mode's federations apart, and one sealed mnemonic per mode for all of them", async () => {
    const w = await wallet();
    await w.join(federation.invite);
    const other = fake.federation({ name: "Second", network: "signet" });
    await w.join(other.invite);
    const mnemonics = [...fake.databases.values()].map((d) => d.mnemonic);
    expect(new Set(mnemonics).size, "one mnemonic, a secret per federation derived from it").toBe(1);
    const stored = JSON.stringify(await wrap((await store(STORES.settings, "readonly")).getAll()));
    expect(stored.includes(mnemonics[0]), "the mnemonic is sealed").toBe(false);
    await w.setMode("mainnet");
    expect(w.view.federations).toEqual([]);
    await w.setMode("testnet");
    await w.ensureReady();
    expect(w.view.federations.map((f) => f.name)).toEqual(["Regtest federation", "Second"]);
    expect(w.view.federations.every((f) => f.status === "ready")).toBe(true);
  });

  it("hands notes over and takes them back; notes someone redeemed cannot be taken back", async () => {
    const alice = await funded(5_000);
    const { notes, operationId } = await alice.spendNotes(federation.id, 1_200);
    expect(alice.view.balance).toBe(3_800);
    expect(await alice.inspectNotes(notes)).toEqual({ federation: federation.id, amountMsats: 1_200_000 });
    expect(await alice.takeBack(federation.id, operationId)).toBe("canceled");
    expect(alice.view.balance).toBe(5_000);
    const again = await alice.spendNotes(federation.id, 700);
    const someone = await (await fake.sdk()()).join({ database: "ghostly-fedimint-someone.db", mnemonic: "someone", invite: federation.invite, recover: false });
    await someone.redeem(again.notes, "someone");
    expect(await alice.takeBack(federation.id, again.operationId)).toBe("taken");
    await expect(alice.spendNotes(federation.id, 10_000)).rejects.toThrow("Not enough");
  });

  it("redeems notes pasted on the wallet page, of a federation it joined only", async () => {
    const alice = await funded(3_000);
    const { notes } = await alice.spendNotes(federation.id, 1_000);
    const bob = await wallet();
    await expect(bob.receiveNotes(notes)).rejects.toThrow("Join the federation");
    // Another profile's client (in this process a second wallet would share Alice's store, and her mnemonic).
    const other = await fake.sdk()().then((sdk) => sdk.join({ database: "ghostly-fedimint-bob.db", mnemonic: "bob", invite: federation.invite, recover: false }));
    expect(await other.redeem(notes, "x")).toBeTruthy();
    expect(await other.balance()).toBe(1_000_000);
    await expect(alice.receiveNotes(notes)).rejects.toThrow("already redeemed");
  });

  it("leaves only an empty federation, archives it, and joining it again recovers instead of reusing the keys", async () => {
    const w = await funded(1_000);
    await expect(w.leave(federation.id)).rejects.toThrow("still holds your sats");
    const handed = await w.spendNotes(federation.id, 1_000);
    await expect(w.leave(federation.id), "notes nobody redeemed come back first").rejects.toThrow("came back");
    expect(await w.takeBack(federation.id, handed.operationId)).toBe("canceled");
    const { notes } = await w.spendNotes(federation.id, 1_000);
    const someone = await (await fake.sdk()()).join({ database: "ghostly-fedimint-someone.db", mnemonic: "someone", invite: federation.invite, recover: false });
    await someone.redeem(notes, "someone");
    await w.leave(federation.id);
    expect(w.view.federations).toEqual([]);
    const keys = (await wrap((await store(STORES.settings, "readonly")).getAllKeys())).map(String);
    expect(keys).toContain(`fedimintRetired-testnet-${federation.id}`);
    await w.join(federation.invite);
    expect(federation.joined.get([...fake.databases.values()][0].mnemonic), "joined fresh once, then recovered").toBe(2);
  });

  it("backs up the mnemonic and the federations, and restores them through each federation's recovery", async () => {
    const w = await funded(4_200);
    const second = fake.federation({ name: "Second", network: "signet" });
    await w.join(second.invite);
    const { invoice } = await w.createInvoice(second.id, 800); second.payInvoice(invoice);
    const file = await w.exportBackup("correct horse battery");
    expect(file.includes(federation.invite), "sealed").toBe(false);
    await expect(w.restoreBackup(file, "correct horse battery"), "never over a wallet with federations").rejects.toThrow("will not be replaced");
    // A new profile (a clean store) restores it.
    await transact([STORES.settings], (s) => { s[STORES.settings].clear(); });
    const restored = await wallet();
    await expect(restored.restoreBackup(file, "wrong password here")).rejects.toThrow();
    expect(await restored.restoreBackup(file, "correct horse battery")).toEqual({ joined: 2, failed: [] });
    await restored.refresh();
    expect(restored.view.balance, "the federations gave the ecash back").toBe(5_000);
  });

  it("describes client operations as history", () => {
    const f = federation.id;
    expect(historyEntry(f, { id: "1", kind: "mint", variant: "spend_o_o_b", createdAt: 1, amountMsats: 2_000_000, outcome: "UserCanceledSuccess" })).toMatchObject({ kind: "notes-out", amount: 2_000, state: "taken-back" });
    expect(historyEntry(f, { id: "2", kind: "mint", variant: "reissuance", createdAt: 1, amountMsats: 5_000_000, outcome: "Done" })).toMatchObject({ kind: "notes-in", amount: 5_000, state: "done" });
    expect(historyEntry(f, { id: "3", kind: "ln", variant: "pay", createdAt: 1, invoice: fakeInvoice(3_000, new Uint8Array(32)), feeMsats: 11_009, outcome: { success: { preimage: "ab" } } })).toMatchObject({ kind: "lightning-out", amount: 3_000, fee: 12, state: "done" });
    expect(historyEntry(f, { id: "4", kind: "ln", variant: "receive", createdAt: 1, outcome: "claimed", invoice: fakeInvoice(20, new Uint8Array(32)) })).toMatchObject({ kind: "lightning-in", amount: 20, state: "done" });
    expect(historyEntry(f, { id: "5", kind: "meta", createdAt: 1 })).toBeUndefined();
    expect(() => normalizeInvite("fed1abc")).toThrow();
  });

  it("reads the network of a v1 wallet module from its consensus-encoded config", () => {
    // What a regtest federation of fedimintd 0.12.1 answered (e2e/infra), shortened around the network.
    const config = { global: { api_endpoints: { 0: { url: "ws://127.0.0.1:47140/", name: "ghostly-guardian" } }, consensus_version: { major: 2, minor: 1 }, meta: { federation_name: "Ghostly regtest" } },
      modules: { 0: { kind: "ln", config: "00" }, 1: { kind: "mint", config: "00" }, 2: { kind: "wallet", config: "037e51776b6828fedab5bffa0afe000f4240" } } };
    expect(federationInfo("ab".repeat(32), config)).toMatchObject({ name: "Ghostly regtest", network: "regtest", consensusVersion: "2.1", modules: ["ln", "mint", "wallet"], guardians: [{ name: "ghostly-guardian", url: "ws://127.0.0.1:47140/" }] });
    expect(federationInfo("ab".repeat(32), { ...config, modules: { 0: { kind: "wallet", config: "fed9b4bef9" } } }).network).toBe("bitcoin");
    expect(federationInfo("ab".repeat(32), { ...config, modules: { 0: { kind: "wallet", config: "fed9b4bef9fedab5bffa" } } }).network, "two networks: unknown").toBeUndefined();
    // A preview (before joining) names it `unknown_module_hex`; without a wallet module, the Lightning module says it.
    expect(federationInfo("ab".repeat(32), { ...config, modules: { 0: { kind: "ln", unknown_module_hex: "0037a8ae30fedab5bffa" }, 1: { kind: "mint", unknown_module_hex: "02fd" } } }).network).toBe("regtest");
  });
});

// ── The chat ───────────────────────────────────────────────────────────────────────────────────────────────

function chat(fedimint: FedimintWallet, opts: { fedimint?: boolean; lightning?: boolean } = {}) {
  const sent: { kind: string; frame: Record<string, unknown> }[] = [];
  const link = {
    requirePaymentSupport: vi.fn(async () => {}), supportsFedimintPayments: opts.fedimint ?? true, supportsPayments: true, isDataLinkOpen: true,
    allowsPayment: (m: string) => m === "fedimint" ? opts.fedimint ?? true : m === "lightning" ? opts.lightning ?? true : true,
    paymentEnabled: () => true,
    sendPaymentRequest: vi.fn(async (frame: Record<string, unknown>) => { sent.push({ kind: "req", frame }); }),
    sendPaymentAsk: vi.fn(async (frame: Record<string, unknown>) => { sent.push({ kind: "ask", frame }); }),
    sendPayment: vi.fn(async (frame: Record<string, unknown>) => { sent.push({ kind: "pay", frame }); }),
    sendPaymentResult: vi.fn((frame: Record<string, unknown>) => { sent.push({ kind: "res", frame }); }),
  };
  const host = { getLink: () => link as unknown as GhostLink, storeMessage: vi.fn(async () => {}), onChange: vi.fn(), onReviewedPaymentResult: vi.fn(async () => {}), onReviewedPaymentRefused: vi.fn(async () => {}) };
  const desk = new PaymentDesk({} as CashuWallet, host, undefined, undefined, undefined, undefined, undefined, fedimint);
  return { desk, sent, link, host };
}
const reviewOf = (target: ReturnType<FedimintWallet["target"]>, amount: number, requestId?: string): PaymentReview =>
  ({ ...target, id: crypto.randomUUID(), payee: "bob", linkId: "l", requestId, amount, fee: 0, feeCap: 10, createdAt: Date.now(), state: "pending" });

describe("Fedimint in a chat", () => {
  it("a request carries the payee's federations and an invoice of its gateway, and needs Fedimint on both sides", async () => {
    const w = await funded(0);
    const { desk, sent } = chat(w);
    await desk.start();
    await desk.request({ linkId: "l", amount: 1_500, timestamp: 1, method: "fedimint", memo: "lunch" });
    const endpoints = sent[0].frame.endpoints as [string, string][];
    expect(endpoints.map((e) => e[0])).toEqual([ENDPOINT.fedimint, ENDPOINT.bolt11]);
    expect(parseFedimintRequestPayload(endpoints[0][1])).toEqual([federation.id]);
    expect(desk.payment(sent[0].frame.id as string)).toMatchObject({ federations: [federation.id], invoice: endpoints[1][1] });
    const noLightning = chat(w, { lightning: false });
    await noLightning.desk.request({ linkId: "l", amount: 5, timestamp: 2, method: "fedimint" });
    expect((noLightning.sent[0].frame.endpoints as [string, string][]).map((e) => e[0]), "Lightning off: no invoice").toEqual([ENDPOINT.fedimint]);
    await expect(chat(w, { fedimint: false }).desk.request({ linkId: "l", amount: 1, timestamp: 3, method: "fedimint" })).rejects.toThrow("Both peers need Fedimint");
    const empty = await wallet(); await transact([STORES.settings], (s) => { s[STORES.settings].clear(); }); await empty.start(); await empty.setMode("testnet");
    await expect(chat(empty).desk.request({ linkId: "l", amount: 1, timestamp: 4, method: "fedimint" })).rejects.toThrow("Join a federation first");
  });

  it("the invoice of a request settles it when it is paid into the federation, across a restart", async () => {
    const events = { changed: vi.fn(), received: vi.fn() };
    const w = await wallet("testnet", events); await w.join(federation.invite);
    const { desk, sent } = chat(w);
    await desk.request({ linkId: "l", amount: 300, timestamp: 1, method: "fedimint" });
    const invoice = (sent[0].frame.endpoints as [string, string][])[1][1];
    await w.stop();
    federation.payInvoice(invoice);
    const again = await wallet("testnet", events);
    await again.ensureReady();
    await vi.waitFor(() => expect(events.received).toHaveBeenCalledWith(sent[0].frame.id, federation.id));
  });

  it("the payer reviews ecash of a shared federation; a request of another federation is paid over Lightning", async () => {
    const payer = await funded(2_000);
    const { desk } = chat(payer);
    const request = (id: string, federations: string[], invoice?: string) => ({ id, timestamp: Date.now(), amount: { value: "500", asset: "sat" },
      endpoints: [[ENDPOINT.fedimint, JSON.stringify({ federations })], ...(invoice ? [[ENDPOINT.bolt11, invoice]] : [])] as [string, string][] });
    const elsewhere = "cd".repeat(32), invoice = fakeInvoice(500, new Uint8Array(32).fill(7));
    await desk.onPaymentRequest("l", request("shared", [elsewhere, federation.id]));
    await desk.onPaymentRequest("l", request("apart", [elsewhere], invoice));
    await desk.onPaymentRequest("l", request("junk", ["not a federation"]));
    expect(desk.payment("shared")).toMatchObject({ target: { method: "fedimint", provider: federation.id, network: "regtest", address: "shared" } });
    expect(validatePaymentTarget(desk.payment("shared")!.target)).toBeTruthy();
    expect(desk.payment("apart")).toMatchObject({ federations: [elsewhere], invoice });
    expect(desk.payment("apart")!.target, "no federation in common: its invoice").toBeUndefined();
    expect(desk.payment("junk")).toBeUndefined();
    const off = chat(payer, { fedimint: false });
    await off.desk.onPaymentRequest("l", request("off", [federation.id]));
    expect(off.desk.payment("off")).toBeUndefined();
  });

  it("pays after approval: the payment is written down before the notes exist, and the payee redeems them once", async () => {
    const payer = await funded(3_000);
    const payerChat = chat(payer);
    await payerChat.desk.start();
    const target = payer.target(federation.id, "req-1");
    // The request as the payer holds it.
    await payerChat.desk.onPaymentRequest("l", { id: "req-1", timestamp: Date.now(), amount: { value: "1000", asset: "sat" }, endpoints: [[ENDPOINT.fedimint, JSON.stringify({ federations: [federation.id] })]] });
    const adapter = new FedimintAdapter(payer, payerChat.desk.fedimintPublisher);
    const coordinator = new PaymentCoordinator(intentRepository, [adapter]);
    const review = await coordinator.prepare(target, 1_000, 10, { payee: "bob", linkId: "l", requestId: "req-1" });
    expect(review.fee).toBe(0);
    expect(fake.spent, "nothing spent at review").toBe(0);
    const approved = await coordinator.approve(review.id);
    expect(approved.state).toBe("submitted");
    const out = payerChat.desk.payment(review.id)!;
    expect(out).toMatchObject({ direction: "out", state: "pending", federation: federation.id, token: expect.stringMatching(/^fakenotes/) });
    const frame = payerChat.sent.find((s) => s.kind === "pay")!.frame as { endpoint: [string, string]; id: string };
    expect(frame.endpoint[0]).toBe(ENDPOINT.fedimint);
    expect(payerChat.desk.views()[review.id], "the notes never reach a page").not.toHaveProperty("token");

    // The payee: another profile's wallet, over a client of its own mnemonic (in this process a second
    // FedimintWallet would share the payer's store and mnemonic).
    const bobClient = await (await fake.sdk()()).join({ database: "ghostly-fedimint-bob2.db", mnemonic: "bob", invite: federation.invite, recover: false });
    const bobWallet = { inspectNotes: async (n: string) => ({ federation: federation.id, amountMsats: (await bobClient.parseNotes(n)).amountMsats }),
      redeemNotes: async (_f: string, n: string, g: string) => { const op = await bobClient.redeem(n, g); return { operationId: op, state: await bobClient.redeemState(op, 0) }; },
      redeemState: (_f: string, op: string) => bobClient.redeemState(op, 0), federation: () => ({ network: "regtest" }), requestFederations: () => [federation.id] } as unknown as FedimintWallet;
    const payeeChat = chat(bobWallet);
    // Another profile's store: in this process both desks share one database, so it starts from the payee's own records.
    await transact([STORES.payments], (s) => { s[STORES.payments].clear(); });
    await transact([STORES.payments], (s) => { s[STORES.payments].put({ id: "req-1", linkId: "l", kind: "request", direction: "out", amount: 1_000, unit: "sat", state: "pending", createdAt: 1, federations: [federation.id] } satisfies StoredPayment); });
    await payeeChat.desk.start();
    await payeeChat.desk.onPayment("l", { id: frame.id, timestamp: Date.now(), requestId: "req-1", amount: { value: "1000", asset: "sat" }, endpoint: frame.endpoint });
    expect(payeeChat.desk.payment(frame.id)).toMatchObject({ direction: "in", state: "settled", amount: 1_000 });
    expect(payeeChat.desk.payment(frame.id)!.token, "redeemed: the copy is dropped").toBeUndefined();
    expect(payeeChat.desk.payment("req-1")!.state).toBe("settled");
    expect(await bobClient.balance()).toBe(1_000_000);
    const result = payeeChat.sent.find((s) => s.kind === "res")!.frame;
    expect(result).toMatchObject({ id: frame.id, ok: true });
    // A retransmission redeems nothing twice and says the same.
    await payeeChat.desk.onPayment("l", { id: frame.id, timestamp: Date.now(), requestId: "req-1", amount: { value: "1000", asset: "sat" }, endpoint: frame.endpoint });
    expect(payeeChat.sent.filter((s) => s.kind === "res").map((s) => s.frame.ok)).toEqual([true, true]);
    expect(await bobClient.balance()).toBe(1_000_000);

    // The payer hears it, and reconciling settles the review without spending again.
    await payerChat.desk.onPaymentResult("l", { id: frame.id, ok: true, credited: "1000" });
    expect(payerChat.desk.payment(review.id)).toMatchObject({ state: "settled", token: undefined });
    expect(payerChat.desk.payment("req-1")!.state).toBe("settled");
    expect((await coordinator.reconcile(review.id)).state).toBe("settled");
    expect(fake.spent).toBe(1);
  });

  it("notes the contact refuses come back, and the review closes as failed", async () => {
    const payer = await funded(2_000);
    const { desk, host } = chat(payer);
    const coordinator = new PaymentCoordinator(intentRepository, [new FedimintAdapter(payer, desk.fedimintPublisher)]);
    await desk.onPaymentRequest("l", { id: "r", timestamp: Date.now(), amount: { value: "600", asset: "sat" }, endpoints: [[ENDPOINT.fedimint, JSON.stringify({ federations: [federation.id] })]] });
    const review = await coordinator.prepare(desk.payment("r")!.target!, 600, 10, { payee: "bob", linkId: "l", requestId: "r" });
    await coordinator.approve(review.id);
    await payer.refresh();
    expect(payer.view.balance).toBe(1_400);
    await desk.onPaymentResult("l", { id: review.id, ok: false, error: "These notes are from a federation I have not joined" });
    expect(desk.payment(review.id)).toMatchObject({ state: "reclaimed" });
    expect(host.onReviewedPaymentRefused).toHaveBeenCalledWith(review.id, expect.stringContaining("have not joined"));
    await payer.refresh();
    expect(payer.view.balance).toBe(2_000);
  });

  it("the payee refuses notes of a federation it has not joined, and Fedimint when it is off, redeeming nothing", async () => {
    const payer = await funded(1_000);
    const { notes } = await payer.spendNotes(federation.id, 400);
    const payee = await (async () => { const w = new FedimintWallet({ changed: vi.fn(), received: vi.fn() }, fake.sdk()); await w.start(); await w.setMode("testnet"); return w; })();
    const { desk, sent } = chat(payee);
    await desk.onPayment("l", { id: "p1", timestamp: 1, amount: { value: "400", asset: "sat" }, endpoint: [ENDPOINT.fedimint, notes] });
    expect(sent.at(-1)!.frame).toMatchObject({ id: "p1", ok: false, error: expect.stringContaining("have not joined") });
    const off = chat(payer, { fedimint: false });
    await off.desk.onPayment("l", { id: "p2", timestamp: 2, amount: { value: "400", asset: "sat" }, endpoint: [ENDPOINT.fedimint, notes] });
    expect(off.sent.at(-1)!.frame).toMatchObject({ ok: false, error: "Fedimint is off in this chat" });
    expect(federation.notes.get(notes)!.spent, "still the payer's to take back").toBe(false);
  });

  it("reconciling an interrupted payment never spends twice: notes made but not written down are taken back", async () => {
    const payer = await funded(2_000);
    const { desk, sent } = chat(payer);
    const target = payer.target(federation.id, "r");
    // The journal entry without notes, as a crash between the spend and writing them down leaves it.
    const review = reviewOf(target, 500, "r");
    await desk.fedimintPublisher.journal(review);
    await payer.client(federation.id).spend(500_000, { cancelAfterSecs: 60, ghostly: review.id });
    const adapter = new FedimintAdapter(payer, desk.fedimintPublisher);
    expect(await adapter.reconcile(review)).toMatchObject({ failed: true, error: expect.stringContaining("sats came back") });
    expect(desk.payment(review.id)!.state).toBe("reclaimed");
    expect(sent.filter((s) => s.kind === "pay"), "nothing reached the contact").toHaveLength(0);
    await payer.refresh();
    expect(payer.view.balance).toBe(2_000);
    // A payment whose spend never happened is simply failed, nothing to take back.
    expect(await adapter.reconcile(reviewOf(target, 100))).toMatchObject({ failed: true, error: "Nothing was spent" });
    // With its notes written down: the same notes again, never new ones.
    const kept = reviewOf(target, 300);
    await desk.fedimintPublisher.journal(kept);
    const spent = await payer.client(federation.id).spend(300_000, { cancelAfterSecs: 60, ghostly: kept.id });
    await desk.fedimintPublisher.publish(kept, spent.notes, spent.operationId);
    const before = fake.spent;
    expect(await adapter.reconcile(kept)).toMatchObject({ pending: true });
    expect(sent.filter((s) => s.kind === "pay").map((s) => (s.frame.endpoint as string[])[1])).toEqual([spent.notes, spent.notes]);
    expect(fake.spent).toBe(before);
  });

  it("a spend the federation refuses is failed with nothing spent; a mismatched review never runs", async () => {
    const payer = await funded(500);
    const { desk } = chat(payer);
    const adapter = new FedimintAdapter(payer, desk.fedimintPublisher);
    const target = payer.target(federation.id, "r");
    await expect(adapter.prepare(target, 900, 10)).rejects.toThrow("Not enough");
    await expect(adapter.execute({ ...reviewOf(target, 400), linkId: undefined }, { federation: federation.id, amount: 400 })).rejects.toBeInstanceOf(PaymentPreflightError);
    await expect(adapter.execute(reviewOf(target, 400), { federation: federation.id, amount: 300 })).rejects.toBeInstanceOf(PaymentPreflightError);
    fake.failNextSpend = true;
    const review = reviewOf(target, 400);
    await expect(adapter.execute(review, { federation: federation.id, amount: 400 })).rejects.toThrow("did not answer");
    expect(await adapter.reconcile(review)).toMatchObject({ failed: true, error: "Nothing was spent" });
  });

  it("the payer takes back notes nobody redeemed, and learns it when someone did", async () => {
    const payer = await funded(1_000);
    const { desk } = chat(payer);
    const target = payer.target(federation.id, "r");
    const review = reviewOf(target, 400);
    await desk.fedimintPublisher.journal(review);
    const spent = await payer.client(federation.id).spend(400_000, { cancelAfterSecs: 60, ghostly: review.id });
    await desk.fedimintPublisher.publish(review, spent.notes, spent.operationId);
    await desk.reclaim(review.id);
    expect(desk.payment(review.id)!.state).toBe("reclaimed");
    const second = reviewOf(target, 300);
    await desk.fedimintPublisher.journal(second);
    const s2 = await payer.client(federation.id).spend(300_000, { cancelAfterSecs: 60, ghostly: second.id });
    await desk.fedimintPublisher.publish(second, s2.notes, s2.operationId);
    const contact = await (await fake.sdk()()).join({ database: "ghostly-fedimint-contact.db", mnemonic: "contact", invite: federation.invite, recover: false });
    await contact.redeem(s2.notes, "the contact");
    await desk.reclaim(second.id);
    expect(desk.payment(second.id)!.state, "redeemed by the contact: paid").toBe("settled");
  });
});

describe("the Fedimint Lightning source", () => {
  it("is a well-formed provider that needs a joined federation", async () => {
    expect(providerDescriptorProblems(fedimintDescriptor)).toEqual([]);
    const w = await funded(0);
    const host = { platform: "web" as const, mode: "testnet" as const, signal: new AbortController().signal, fedimint: w };
    expect(() => fedimintDescriptor.validate!({ config: { federation: "nope" }, secrets: {} }, "testnet")).toThrow();
    await expect(fedimintDescriptor.create({ config: { federation: "ef".repeat(32) }, secrets: {} }, host)).rejects.toThrow("not joined");
    const source = await fedimintDescriptor.create({ config: { federation: federation.id }, secrets: {} }, host);
    expect(await source.info()).toMatchObject({ network: "regtest", alias: "Regtest federation", balance: 0 });
  });

  it("receives into the federation and pays out through its gateway, within the fee limit", async () => {
    const w = await funded(0);
    const source = new FedimintLightning(w, federation.id);
    const invoice = await source.createInvoice(2_000, "coffee");
    expect(await source.invoiceStatus(invoice)).toEqual({ state: "open" });
    federation.payInvoice(invoice.invoice);
    expect(await source.invoiceStatus(invoice)).toEqual({ state: "paid", amount: 2_000 });
    const outside = fakeInvoice(1_000, new Uint8Array(32).fill(9));
    fake.external.set(outside, 1_000_000);
    expect(await source.estimateFee(outside, 1_000)).toBe(2);
    const refused = await source.payInvoice(outside, 1).catch((e: unknown) => e);
    expect(isNothingSpentError(refused), "above the fee limit: refused before anything left").toBe(true);
    const paid = await source.payInvoice(outside, 10);
    expect(paid).toMatchObject({ state: "paid", fee: 2 });
    expect(await source.paymentStatus({ invoice: outside, paymentHash: "", ref: paid.ref })).toMatchObject({ state: "paid" });
    expect(fake.paidOut).toEqual([outside]);
    const tooMuch = fakeInvoice(5_000, new Uint8Array(32).fill(3));
    fake.external.set(tooMuch, 5_000_000);
    expect(isNothingSpentError(await source.payInvoice(tooMuch, 100).catch((e: unknown) => e))).toBe(true);
  });

  it("an invoice of the same federation is paid inside it, with no gateway fee; a payment in flight is pending", async () => {
    const payer = await funded(3_000);
    const payee = await (await fake.sdk()()).join({ database: "ghostly-fedimint-payee.db", mnemonic: "payee", invite: federation.invite, recover: false });
    const { invoice } = await payee.createInvoice(1_000_000, "", 3600, "x");
    const source = new FedimintLightning(payer, federation.id);
    expect(await source.payInvoice(invoice, 10)).toMatchObject({ state: "paid", fee: 0 });
    expect(await payee.balance()).toBe(1_000_000);
    fake.holdPayments = true;
    const outside = fakeInvoice(100, new Uint8Array(32).fill(4)); fake.external.set(outside, 100_000);
    const pending = await source.payInvoice(outside, 10);
    expect(pending.state).toBe("pending");
    expect(await source.paymentStatus({ invoice: outside, paymentHash: "", ref: pending.ref })).toMatchObject({ state: "pending" });
    await settle();
  });
});

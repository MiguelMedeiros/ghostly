import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { bech32 } from "@scure/base";
import { decodeBolt11 } from "@ghostly/core";
import { STORES, store, transact, wrap } from "../src/shared/idb";
import type { CashuWallet } from "../src/engine/wallet";
import { CashuMintLightning, cashuMint, CASHU_MINT_SOURCE } from "../src/engine/paymentAdapters/providers/cashuMint";
import type { LightningProvider, LightningProviderDescriptor } from "../src/engine/paymentAdapters/providers/lightning";
import { LightningService, type LightningEvents, type LightningOp } from "../src/engine/paymentAdapters/providers/lightningService";
import { ProviderSources } from "../src/engine/paymentAdapters/providers/sources";
import { FakeLightningProvider, fakeInvoice, fakeLightning } from "../src/engine/paymentAdapters/providers/testing";
import type { ProviderDescriptor, ProviderNetwork } from "../src/engine/paymentAdapters/providers/types";
import { testInvoice } from "../../core/test/invoice";
// covers: wallet.lightning.sources, wallet.onchain.sources, wallet.mode

/**
 * The engine's Lightning service of one network and the sources under it: what reaches a contact is the invoice
 * asked for, a quote is paid only through the source that made it, every outcome is journaled and only
 * ever reconciled, and a source is connected only on a chain of its own network.
 */

const keys = async () => (await wrap((await store(STORES.settings, "readonly")).getAllKeys())).map(String).sort();
const hash = () => crypto.getRandomValues(new Uint8Array(32));
const journal = (op: LightningOp) => transact([STORES.settings], (s) => { s[STORES.settings].put(op, `lightningOp-${op.direction}-${op.paymentHash}`); });
beforeEach(async () => { await transact([STORES.settings], (s) => { s[STORES.settings].clear(); }); });

const services: LightningService[] = [];
afterEach(async () => { for (const s of services.splice(0)) await s.stop(); });

function service(provider: LightningProvider = new FakeLightningProvider({ settleMs: 600_000 }), extra: Partial<LightningProviderDescriptor> = {}) {
  const events = { changed: vi.fn(), received: vi.fn(), resolved: vi.fn() } satisfies LightningEvents;
  const cashu = { view: async () => ({ balance: 7, mints: [], history: [], feesPaid: 0 }) } as unknown as CashuWallet;
  // Nothing secret to configure: no sealing (a 600k-round PBKDF2) on every set.
  const descriptor: LightningProviderDescriptor = { ...fakeLightning, fields: [], validate: undefined, create: async () => provider, ...extra };
  const lightning = new LightningService("testnet", () => [cashuMint, descriptor], () => ({ platform: "web", cashu }), events, CASHU_MINT_SOURCE);
  services.push(lightning);
  return { lightning, events, provider };
}
async function ready(provider?: LightningProvider, extra?: Partial<LightningProviderDescriptor>) {
  const setup = service(provider, extra);
  await setup.lightning.start();
  await setup.lightning.sources.set("fake-lightning", {});
  return setup;
}
const opOf = async (lightning: LightningService, paymentHash: string) => (await lightning.list()).find((op) => op.paymentHash === paymentHash);
const op = (extra: Partial<LightningOp>): LightningOp => ({ direction: "out", providerId: "fake-lightning", mode: "testnet", paymentHash: "aa", invoice: "x", amount: 5, expiresAt: Date.now() + 60_000, createdAt: 1, state: "pending", ...extra });

describe("a source's view", () => {
  it("shows no balance for a source that keeps none, and a new provider list reaches the picker", async () => {
    const fake = new FakeLightningProvider();
    Object.assign(fake, { capabilities: { ...fake.capabilities, balance: false } });
    const { lightning, events } = await ready(fake);
    await vi.waitFor(() => expect(lightning.view.status).toBe("ready"));
    expect(lightning.view.balance).toBeUndefined();
    events.changed.mockClear();
    lightning.refreshOffered();
    expect(events.changed).toHaveBeenCalled();
  });
});

describe("the invoice a contact is handed", () => {
  it("comes only from a source that can receive", async () => {
    const fake = new FakeLightningProvider();
    Object.assign(fake, { capabilities: { ...fake.capabilities, receive: false } });
    const { lightning } = await ready(fake);
    await expect(lightning.createInvoice(10)).rejects.toThrow("cannot create invoices");
  });

  it("is refused when the source returns another amount or another payment hash than it says", async () => {
    const fake = new FakeLightningProvider({ settleMs: 600_000 });
    const make = fake.createInvoice.bind(fake);
    const { lightning } = await ready(fake);
    fake.createInvoice = async (amount, memo) => ({ ...(await make(amount + 1, memo)), amount });
    await expect(lightning.createInvoice(10)).rejects.toThrow("does not match the request");
    fake.createInvoice = async (amount, memo) => ({ ...(await make(amount, memo)), paymentHash: "00".repeat(32) });
    await expect(lightning.createInvoice(10)).rejects.toThrow("does not match the request");
    expect((await keys()).filter((k) => k.startsWith("lightningOp-")), "nothing journaled").toEqual([]);
  });
});

describe("the Cashu wallet reporting its own invoices and melts", () => {
  it("marks a journaled invoice paid and names its chat request; an older quote carries its own", async () => {
    const { lightning, events } = await ready();
    const invoice = await lightning.createInvoice(21, { paymentId: "req-1" });
    await lightning.reportInvoicePaid(invoice.invoice, { mint: "https://mint.example" });
    expect(await opOf(lightning, invoice.paymentHash)).toMatchObject({ state: "paid" });
    expect(events.received).toHaveBeenLastCalledWith({ paymentId: "req-1", providerId: "fake-lightning", mint: "https://mint.example" });
    await lightning.reportInvoicePaid(invoice.invoice);
    expect(events.received).toHaveBeenCalledTimes(2);

    await lightning.reportInvoicePaid(fakeInvoice(5, hash()), { paymentId: "legacy" });
    await lightning.reportInvoicePaid("not an invoice", { paymentId: "garbled" });
    expect(events.received.mock.calls.slice(2).map((c) => c[0])).toEqual([
      { paymentId: "legacy", providerId: CASHU_MINT_SOURCE, mint: undefined },
      { paymentId: "garbled", providerId: CASHU_MINT_SOURCE, mint: undefined },
    ]);
  });

  it("settles or fails a journaled pending melt, and passes on one it never journaled", async () => {
    const { lightning, events } = await ready();
    const paid = fakeInvoice(5, hash()), lost = fakeInvoice(6, hash());
    const hashOf = (invoice: string) => decodeBolt11(invoice)!.paymentHash!;
    // Melts of the Cashu wallet book themselves: the service's own passes never ask about them.
    const melt = { providerId: CASHU_MINT_SOURCE, selfSettled: true };
    await journal(op({ ...melt, paymentHash: hashOf(paid), invoice: paid, paymentId: "r-paid" }));
    await journal(op({ ...melt, paymentHash: hashOf(lost), invoice: lost, paymentId: "r-lost" }));
    await lightning.reportPaymentResolved(paid, true);
    await lightning.reportPaymentResolved(lost, false);
    await lightning.reportPaymentResolved(fakeInvoice(7, hash()), true, { paymentId: "old-melt", mint: "m" });
    expect((await opOf(lightning, hashOf(paid)))?.state).toBe("paid");
    expect((await opOf(lightning, hashOf(lost)))?.state).toBe("failed");
    expect(events.resolved.mock.calls).toEqual([
      [{ paymentId: "r-paid", providerId: CASHU_MINT_SOURCE, mint: undefined }, true],
      [{ paymentId: "r-lost", providerId: CASHU_MINT_SOURCE, mint: undefined }, false],
      [{ paymentId: "old-melt", providerId: CASHU_MINT_SOURCE, mint: "m" }, true],
    ]);
  });
});

describe("quoting an invoice to pay", () => {
  it("refuses what is not a payable invoice: garbage, no amount, expired", async () => {
    const { lightning } = await ready();
    await expect(lightning.quote("hello")).rejects.toThrow("not a Lightning invoice");
    const amountless = bech32.encode("lnbcrt", bech32.decode(fakeInvoice(10, hash()) as `${string}1${string}`, false).words, false);
    await expect(lightning.quote(amountless)).rejects.toThrow("without an amount");
    const expired = testInvoice({ sats: 10, prefix: "lnbcrt", createdAt: Math.floor(Date.now() / 1000) - 7200, expirySeconds: 60 });
    await expect(lightning.quote(expired)).rejects.toThrow("has expired");
  });

  it("refuses a source that cannot pay, or one that states a fee that is not a whole number of sats", async () => {
    const fake = new FakeLightningProvider();
    Object.assign(fake, { capabilities: { ...fake.capabilities, send: false } });
    const { lightning } = await ready(fake);
    await expect(lightning.quote(fakeInvoice(10, hash()))).rejects.toThrow("cannot pay invoices");
    const odd = new FakeLightningProvider();
    odd.estimateFee = async () => 1.5;
    const other = await ready(odd);
    await expect(other.lightning.quote(fakeInvoice(10, hash()))).rejects.toThrow("returned an invalid fee");
  });

  it("gives a source that cannot tell its fee the chat ceiling: 3%, at least 10 sats", async () => {
    const fake = new FakeLightningProvider();
    Object.assign(fake, { estimateFee: undefined });
    const { lightning } = await ready(fake);
    expect((await lightning.quote(fakeInvoice(100, hash()))).feeReserve).toBe(10);
    expect((await lightning.quote(fakeInvoice(1_000, hash()))).feeReserve).toBe(30);
  });

  it("names the Cashu mint that will pay when the source is the mints", async () => {
    const invoice = fakeInvoice(40, hash());
    const wallet = { quoteInvoice: vi.fn(async () => ({ quote: "m1", mint: "https://mint.example", amount: 40, feeReserve: 2 })), view: async () => ({ balance: 100 }) };
    const mints = new CashuMintLightning(wallet as unknown as CashuWallet, "testnet");
    const { lightning } = await ready(mints, { networks: ["testnet"] });
    expect(await lightning.quote(invoice)).toMatchObject({ mint: "https://mint.example", feeReserve: 2, source: "fake-lightning" });
  });
});

describe("paying a quote", () => {
  it("pays only a quote it made, and only through the source that made it", async () => {
    const first = new FakeLightningProvider(), second = new FakeLightningProvider();
    let next: FakeLightningProvider = first;
    const { lightning } = await ready(undefined, { create: async () => next });
    await expect(lightning.pay("made-up")).rejects.toThrow("no longer valid");
    const { quote } = await lightning.quote(fakeInvoice(10, hash()));
    next = second;
    await lightning.sources.set("fake-lightning", {});
    await expect(lightning.pay(quote)).rejects.toThrow("source changed");
    expect(lightning.hasQuote(quote)).toBe(false);
    expect([first.paid, second.paid]).toEqual([[], []]);
  });

  it("a payment the source leaves in flight is pending, and is asked about later rather than paid again", async () => {
    const fake = new FakeLightningProvider();
    fake.payInvoice = async () => ({ state: "pending" });
    const { lightning } = await ready(fake);
    const invoice = fakeInvoice(10, hash());
    expect(await lightning.pay((await lightning.quote(invoice)).quote)).toBe(false);
    expect((await lightning.list())[0]).toMatchObject({ direction: "out", state: "pending" });
    await expect(lightning.pay((await lightning.quote(invoice)).quote)).rejects.toThrow("already being paid");
  });

  it("a lost answer from a source that cannot look payments up says to check the wallet itself", async () => {
    const fake = new FakeLightningProvider({ behaviour: "hang" });
    Object.assign(fake, { capabilities: { ...fake.capabilities, lookup: false } });
    const { lightning } = await ready(fake);
    expect(await lightning.pay((await lightning.quote(fakeInvoice(10, hash()))).quote)).toBe(false);
    expect((await lightning.list())[0]).toMatchObject({ state: "unknown", error: expect.stringContaining("check this payment in the wallet itself") });
  });
});

// Connecting a source schedules a pass of its own: every source answer below is scripted before an
// operation is journaled, so whichever pass sees it first gets the same answer.
describe("reconciling what is open", () => {
  it("asks only the source an operation went through, and never a source that cannot look up", async () => {
    const fake = new FakeLightningProvider();
    const status = vi.spyOn(fake, "paymentStatus");
    const { lightning, events } = await ready(fake);
    await journal(op({ paymentHash: "01", providerId: "another-node" }));
    await journal(op({ paymentHash: "02", mode: "mainnet" }));
    await journal(op({ paymentHash: "03", selfSettled: true }));
    await lightning.reconcile();
    expect(status).not.toHaveBeenCalled();
    Object.assign(fake, { capabilities: { ...fake.capabilities, lookup: false } });
    await journal(op({ paymentHash: "04" }));
    await lightning.reconcile();
    expect(status).not.toHaveBeenCalled();
    expect(events.resolved).not.toHaveBeenCalled();
  });

  it("an open invoice is expired when the source says so, or a minute past its expiry", async () => {
    const fake = new FakeLightningProvider();
    const { lightning } = await ready(fake);
    fake.invoiceStatus = async (invoice) => ({ state: invoice.paymentHash === "11" ? "open" : "expired" });
    await journal(op({ direction: "in", paymentHash: "10", state: "open", expiresAt: Date.now() + 60_000 }));
    await journal(op({ direction: "in", paymentHash: "11", state: "open", expiresAt: Date.now() - 61_000 }));
    await lightning.reconcile();
    expect([(await opOf(lightning, "10"))?.state, (await opOf(lightning, "11"))?.state]).toEqual(["expired", "expired"]);
  });

  it("a payment the source says failed is failed, keeping the fee it already knew, and the chat is told", async () => {
    const fake = new FakeLightningProvider();
    const { lightning, events } = await ready(fake);
    await journal(op({ paymentHash: "20", paymentId: "r20", fee: 3, state: "unknown" }));
    await lightning.reconcile();
    expect(await opOf(lightning, "20")).toMatchObject({ state: "failed", fee: 3, error: "The payment did not go through" });
    expect(events.resolved).toHaveBeenCalledWith(expect.objectContaining({ paymentId: "r20" }), false);
  });

  it("an answer that arrives after something newer was written never overwrites it", async () => {
    const fake = new FakeLightningProvider();
    const { lightning, events } = await ready(fake);
    const invoice = fakeInvoice(9, hash());
    fake.invoiceStatus = async () => { await journal(op({ direction: "in", paymentHash: "30", invoice, state: "paid" })); return { state: "expired" }; };
    fake.paymentStatus = async () => { await journal(op({ paymentHash: "31", state: "paid" })); return { state: "failed" }; };
    await journal(op({ direction: "in", paymentHash: "30", invoice, state: "open" }));
    await journal(op({ paymentHash: "31", state: "pending" }));
    await lightning.reconcile();
    expect([(await opOf(lightning, "30"))?.state, (await opOf(lightning, "31"))?.state]).toEqual(["paid", "paid"]);
    expect(events.received).not.toHaveBeenCalled();
    expect(events.resolved).not.toHaveBeenCalled();
  });

  it("a source that cannot be asked right now changes nothing", async () => {
    const fake = new FakeLightningProvider();
    const { lightning, events } = await ready(fake);
    fake.invoiceStatus = async () => { throw new Error("offline"); };
    fake.paymentStatus = async () => { throw new Error("offline"); };
    await journal(op({ direction: "in", paymentHash: "40", state: "open" }));
    await journal(op({ paymentHash: "41", state: "unknown" }));
    await lightning.reconcile();
    expect([(await opOf(lightning, "40"))?.state, (await opOf(lightning, "41"))?.state]).toEqual(["open", "unknown"]);
    expect(events.resolved).not.toHaveBeenCalled();
  });

  it("once stopped, nothing is asked any more", async () => {
    const fake = new FakeLightningProvider();
    const status = vi.spyOn(fake, "paymentStatus").mockResolvedValue({ state: "pending" });
    const { lightning } = await ready(fake);
    await journal(op({ paymentHash: "50" }));
    await lightning.stop();
    await lightning.reconcile(); // Lets a pass that began before the stop end.
    status.mockClear();
    await lightning.reconcile();
    await lightning.recover();
    expect(status).not.toHaveBeenCalled();
    expect((await opOf(lightning, "50"))?.state, "a pending payment is not made unknown by recovery").toBe("pending");
  });
});

describe("the sources of each network", () => {
  type Node = { info(): Promise<{ network: ProviderNetwork; alias?: string }>; close: Mock<() => Promise<void>>; balance?: number };
  const node = (network: ProviderNetwork, balance = 5): Node => ({ info: async () => ({ network, alias: "n" }), close: vi.fn(async () => {}), balance });
  const descriptor = (create: (secrets: Record<string, string>) => Promise<Node>, extra: Partial<ProviderDescriptor<Node>> = {}): ProviderDescriptor<Node> => ({
    id: "node", label: "Node", kind: "lightning", description: "A node", networks: ["regtest", "bitcoin"], platforms: ["web"],
    fields: [{ name: "key", label: "Key", kind: "secret", optional: true }, { name: "speed", label: "Speed", kind: "select", optional: true, options: [{ value: "fast", label: "Fast" }] }],
    create: (settings) => create(settings.secrets), ...extra,
  });
  function sources(list: ProviderDescriptor<Node>[], options: { defaultId?: string; refresh?: (n: Node) => Promise<{ balance?: number }>; kind?: "lightning" | "onchain"; network?: "mainnet" | "testnet" } = {}) {
    const changed = vi.fn();
    const s = new ProviderSources<Node>({ kind: options.kind ?? "lightning", network: options.network ?? "testnet", descriptors: () => list, host: () => ({ platform: "web" }), changed, defaultId: options.defaultId, refresh: options.refresh });
    return { s, changed };
  }
  const stops: ProviderSources<Node>[] = [];
  afterEach(async () => { for (const s of stops.splice(0)) await s.stop(); });

  it("says plainly when there is no source to use", async () => {
    const lightning = sources([]).s, onchain = sources([], { kind: "onchain" }).s;
    stops.push(lightning, onchain);
    await lightning.start(); await onchain.start();
    await expect(lightning.use()).rejects.toThrow("No Lightning source is set up");
    await expect(onchain.use()).rejects.toThrow("No Bitcoin source is set up");
  });

  it("refuses a node on a network its provider does not support, or on the other network", async () => {
    let network: ProviderNetwork = "signet";
    const { s } = sources([descriptor(async () => node(network))]);
    const mainnet = sources([descriptor(async () => node(network))], { network: "mainnet" }).s;
    stops.push(s, mainnet);
    await s.start(); await mainnet.start();
    await expect(s.set("node", { key: "secret-key" })).rejects.toThrow("runs on signet, which Node does not support here");
    network = "bitcoin";
    await expect(s.set("node", { key: "secret-key" })).rejects.toThrow("real money: set it up as a Mainnet wallet instead");
    network = "regtest";
    await expect(mainnet.set("node", { key: "secret-key" })).rejects.toThrow("a test network: set it up as a Testnet wallet instead");
    await expect(mainnet.set("node", { key: "secret-key", speed: "warp" })).rejects.toThrow("Choose speed");
    expect(await keys()).toEqual([]);
  });

  it("a stored source that cannot connect says why without its secret, and connects on the next try", async () => {
    let fail = true;
    const d = descriptor(async (secrets) => { if (fail) throw new Error(`refused key ${secrets.key}`); return node("regtest"); });
    const first = sources([d]).s;
    stops.push(first);
    await first.start();
    fail = false;
    await first.set("node", { key: "hunter22" });
    fail = true;
    const { s, changed } = sources([d]);
    stops.push(s);
    await s.start();
    await s.ensureReady();
    // One failure is not "unavailable": it is tried again by itself, and says why meanwhile.
    expect(s.view).toMatchObject({ status: "connecting", error: "Could not connect to Node: refused key •••", failures: 1 });
    expect(changed).toHaveBeenCalled();
    await expect(s.use()).rejects.toThrow("refused key •••");
    fail = false;
    await s.ensureReady();
    expect(s.view.status).toBe("ready");
  }, 30_000); // Every attempt unseals the secret (a 600k-round PBKDF2).

  it("a connection still waiting when the source stops is dropped, and closed when it arrives", async () => {
    let arrive!: (n: Node) => void;
    const late = node("regtest");
    const { s } = sources([descriptor(() => new Promise<Node>((resolve) => (arrive = resolve)))], { defaultId: "node" });
    stops.push(s);
    await s.start();
    const connecting = s.ensureReady();
    await vi.waitFor(() => expect(arrive).toBeTypeOf("function"));
    const stopping = s.stop();
    await connecting; await stopping;
    arrive(late);
    await vi.waitFor(() => expect(late.close).toHaveBeenCalled());
    expect(s.active).toBeUndefined();
    expect(s.view).toMatchObject({ mode: "testnet" });
  });

  it("each network has its own source: one still connecting never holds the other back", async () => {
    let arrive!: (n: Node) => void;
    const late = node("regtest");
    const testnet = sources([descriptor(() => new Promise<Node>((resolve) => (arrive = resolve)))], { defaultId: "node" }).s;
    const mainnet = sources([descriptor(async () => node("bitcoin"))], { defaultId: "node", network: "mainnet" }).s;
    stops.push(testnet, mainnet);
    await testnet.start(); await mainnet.start();
    const connecting = testnet.ensureReady();
    await vi.waitFor(() => expect(arrive).toBeTypeOf("function"));
    await mainnet.ensureReady();
    expect(mainnet.view).toMatchObject({ mode: "mainnet", status: "ready", network: "bitcoin" });
    expect(testnet.active).toBeUndefined();
    arrive(late);
    await connecting;
    expect(testnet.view).toMatchObject({ mode: "testnet", status: "ready", network: "regtest" });
    expect(mainnet.view.status).toBe("ready");
  });

  it("choosing the default with nothing to configure stores nothing, and forgets what was stored", async () => {
    const plain = descriptor(async () => node("regtest"), { id: "plain", fields: [] });
    const { s } = sources([plain, descriptor(async () => node("regtest"))], { defaultId: "plain" });
    stops.push(s);
    await s.start();
    await s.set("node", { speed: "fast" });
    expect(await keys()).toEqual(["lightningSource-testnet"]);
    await s.set("plain", {});
    expect(await keys()).toEqual([]);
    expect(s.view).toMatchObject({ providerId: "plain", isDefault: true, status: "ready" });
  });

  it("starting changes nothing on its own, and a new provider list reaches the picker", async () => {
    const { s, changed } = sources([descriptor(async () => node("regtest"))]);
    stops.push(s);
    await s.start();
    expect(changed).not.toHaveBeenCalled();
    s.refreshOffered();
    expect(changed).toHaveBeenCalledOnce();
    expect(s.view.offered.map((d) => d.id)).toEqual(["node"]);
  });

  it("a balance that cannot be read is an error without the secret; one read for a replaced source is dropped", async () => {
    let refresh: (n: Node) => Promise<{ balance?: number }> = async () => { throw new Error("bad key s3cr3t-key"); };
    const a = node("regtest", 1), b = node("regtest", 2);
    let next = a;
    const { s } = sources([descriptor(async () => next)], { refresh: (n) => refresh(n) });
    stops.push(s);
    await s.start();
    await s.set("node", { key: "s3cr3t-key" });
    await vi.waitFor(() => expect(s.view.error).toBe("Could not read the balance: bad key •••"));
    let release!: () => void;
    refresh = async (n) => { if (n === a) await new Promise<void>((resolve) => (release = resolve)); return { balance: n.balance }; };
    const stale = s.refresh();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    next = b;
    await s.set("node", {});
    await vi.waitFor(() => expect(s.view.balance).toBe(2));
    release(); await stale;
    expect(s.view.balance, "the old source's balance never shows").toBe(2);
  });

  it("an error reading a replaced source's balance never shows on the new one", async () => {
    const a = node("regtest", 1), b = node("regtest", 2);
    let next = a, hold = false, fail!: (error: Error) => void;
    const { s } = sources([descriptor(async () => next)], { refresh: async (n) => { if (hold && n === a) await new Promise<void>((_, reject) => (fail = reject)); return { balance: n.balance }; } });
    stops.push(s);
    await s.start();
    await s.set("node", {});
    hold = true;
    const stale = s.refresh();
    await vi.waitFor(() => expect(fail).toBeTypeOf("function"));
    next = b;
    await s.set("node", {});
    await vi.waitFor(() => expect(s.view.balance).toBe(2));
    fail(new Error("gone"));
    await stale;
    expect(s.view.error).toBeUndefined();
    expect(s.view.balance).toBe(2);
  });
});

import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeBolt11 } from "@ghostly/core";
import { STORES, transact } from "../src/shared/idb";
import type { CashuWallet } from "../src/engine/wallet";
import { cashuMint, CASHU_MINT_SOURCE } from "../src/engine/paymentAdapters/providers/cashuMint";
import { LightningService, type LightningEvents } from "../src/engine/paymentAdapters/providers/lightningService";
import { LIGHTNING_PROVIDERS, offeredIn } from "../src/engine/paymentAdapters/providers/registry";
import { fakeInvoice } from "../src/engine/paymentAdapters/providers/testing";
import { NothingSpentError } from "../src/engine/paymentAdapters/providers/types";
import { findWebln, provesPayment, webln, WeblnLightning, type WebLNProvider } from "../src/engine/paymentAdapters/providers/webln";
import { FakeWebln, FakeWeblnLedger, type FakeWeblnOptions } from "./helpers/fakeWebln";
import { describeLightningProvider } from "./helpers/providerContract";
// covers: wallet.lightning.webln.connect, wallet.lightning.webln.pay, wallet.lightning.provider-contract

beforeEach(async () => { await transact([STORES.settings], (s) => { s[STORES.settings].clear(); }); });

const pair = (options: FakeWeblnOptions = {}, other: FakeWeblnOptions = {}) => {
  const ledger = new FakeWeblnLedger();
  return { wallet: new FakeWebln(ledger, options), counterpart: new FakeWebln(ledger, other) };
};
const enabled = async (wallet: FakeWebln) => { await wallet.enable(); return wallet; };

// The same contract every Lightning provider passes, against a WebLN wallet injected into the page.
describeLightningProvider("WebLN (injected fake wallet)", async () => {
  const { wallet, counterpart } = pair({}, { balance: 0 });
  await counterpart.enable();
  const provider = await WeblnLightning.connect(wallet, "testnet");
  return {
    provider, network: "regtest",
    payIncoming: async (invoice) => wallet.receive(invoice.paymentHash),
    payable: async (amount) => (await counterpart.makeInvoice({ amount })).paymentRequest,
    refused: async () => (await counterpart.makeInvoice({ amount: 10_000_000 })).paymentRequest,
  };
});

describe("finding the browser wallet", () => {
  it("is only offered in the web app, in both modes", () => {
    expect(LIGHTNING_PROVIDERS).toContain(webln);
    expect(offeredIn(webln, "web", "mainnet") && offeredIn(webln, "web", "testnet")).toBe(true);
    expect(offeredIn(webln, "extension", "testnet") || offeredIn(webln, "desktop", "mainnet")).toBe(false);
    expect(webln.fields).toEqual([]);
  });

  it("waits a moment for a wallet that injects itself late, and says when there is none", async () => {
    const scope = new EventTarget() as EventTarget & { webln?: unknown };
    const late = findWebln(scope, 1_000);
    setTimeout(() => { scope.webln = new FakeWebln(); scope.dispatchEvent(new Event("webln:ready")); }, 20);
    expect(await late).toBe(scope.webln);
    expect(await findWebln(new EventTarget(), 50)).toBeUndefined();
    expect(await findWebln({ webln: { hello: true } }, 0)).toBeUndefined();
  });

  it("says there is no WebLN wallet, and that one refused the connection", async () => {
    await expect(WeblnLightning.connect(undefined, "mainnet")).rejects.toThrow(/No WebLN wallet in this browser/);
    await expect(WeblnLightning.connect(new FakeWebln(undefined, { refuseEnable: true }), "mainnet")).rejects.toThrow(/refused the connection \(User rejected\)/);
    await expect(WeblnLightning.connect({ enable: async () => ({ enabled: false }) } as WebLNProvider, "mainnet")).rejects.toThrow(/refused the connection/);
    await expect(WeblnLightning.connect({ enable: () => { throw new Error("locked"); } } as unknown as WebLNProvider, "mainnet")).rejects.toThrow(/refused the connection \(locked\)/);
  });
});

describe("what the wallet can do, and which chain it is on", () => {
  it("reads the chain from an invoice it makes when it does not say, and its methods from the list it gives", async () => {
    const wallet = new FakeWebln(undefined, { methods: ["makeInvoice", "sendPayment"] });
    const make = vi.spyOn(wallet, "makeInvoice");
    const provider = await WeblnLightning.connect(wallet, "testnet");
    expect(provider.capabilities).toEqual({ receive: true, send: true, balance: false, lookup: false });
    expect(await provider.info()).toEqual({ network: "regtest", alias: "Fake WebLN" });
    expect(make).toHaveBeenCalledOnce();
  });

  it("takes a chain the wallet names, and refuses invoices of another chain either way", async () => {
    const wallet = new FakeWebln(undefined, { network: "signet" });
    const provider = await WeblnLightning.connect(wallet, "testnet");
    expect((await provider.info()).network).toBe("signet");
    // It says signet but makes regtest invoices: nothing that goes out is trusted on its word.
    await expect(provider.createInvoice(21)).rejects.toThrow(/for regtest, not signet/);
    await expect(provider.payInvoice(fakeInvoice(5, crypto.getRandomValues(new Uint8Array(32))))).rejects.toBeInstanceOf(NothingSpentError);
    expect(wallet.sent).toEqual([]);
  });

  it("a wallet that can only pay, and does not say its chain, is Mainnet only", async () => {
    const payOnly = () => new FakeWebln(undefined, { missing: ["makeInvoice", "getBalance", "lookupInvoice"] });
    await expect(WeblnLightning.connect(payOnly(), "testnet")).rejects.toThrow(/can only be used in Mainnet/);
    const provider = await WeblnLightning.connect(payOnly(), "mainnet");
    expect(provider.capabilities).toEqual({ receive: false, send: true, balance: false, lookup: false });
    expect(await provider.info()).toEqual({ network: "bitcoin", alias: "Fake WebLN" });
    await expect(provider.createInvoice(10)).rejects.toThrow(/cannot make invoices/);
    await expect(WeblnLightning.connect(new FakeWebln(undefined, { methods: ["getBalance"] }), "mainnet")).rejects.toThrow(/neither make nor pay/);
  });

  it("reads a balance in sats or millisats, and none in a fiat currency", async () => {
    expect((await (await WeblnLightning.connect(new FakeWebln(undefined, { balance: 1234, currency: "msats" }), "testnet")).info()).balance).toBe(1234);
    const fiat = await WeblnLightning.connect(new FakeWebln(undefined, { currency: "EUR" }), "testnet");
    expect(fiat.capabilities.balance).toBe(false);
    expect((await fiat.info()).balance).toBeUndefined();
  });

  it("stops answering once closed or disconnected", async () => {
    const controller = new AbortController();
    const provider = await WeblnLightning.connect(new FakeWebln(), "testnet", controller.signal);
    controller.abort();
    await expect(provider.info()).rejects.toThrow(/disconnected/);
    const closed = await WeblnLightning.connect(new FakeWebln(), "testnet");
    await closed.close();
    await expect(closed.createInvoice(1)).rejects.toThrow(/disconnected/);
  });
});

describe("paying through the browser wallet", () => {
  const setup = async (send: FakeWeblnOptions["send"], options: FakeWeblnOptions = {}) => {
    const { wallet, counterpart } = pair({ send, ...options });
    const provider = await WeblnLightning.connect(wallet, "testnet");
    const invoice = (await (await enabled(counterpart)).makeInvoice({ amount: 50 })).paymentRequest;
    return { wallet, counterpart, provider, invoice, hash: decodeBolt11(invoice)!.paymentHash! };
  };

  it("a preimage that proves the hash is paid", async () => {
    const { provider, invoice, hash, counterpart } = await setup("pay");
    const result = await provider.payInvoice(invoice);
    expect(result).toMatchObject({ state: "paid", fee: 0 });
    expect(result.state === "paid" && provesPayment(result.preimage, hash)).toBe(true);
    expect(counterpart.balance).toBe(100_050);
    expect(await provider.paymentStatus({ invoice, paymentHash: hash })).toMatchObject({ state: "paid" });
  });

  it("the person refusing the wallet's prompt, or the wallet finding no route, spent nothing", async () => {
    for (const send of ["reject", "noroute"] as const) {
      const { provider, invoice, wallet } = await setup(send);
      await expect(provider.payInvoice(invoice)).rejects.toBeInstanceOf(NothingSpentError);
      expect(wallet.balance).toBe(100_000);
    }
    // Wallets built on the `webln` library throw its named errors.
    const sendPayment = vi.fn(async () => { throw Object.assign(new Error("Nope"), { name: "RejectionError" }); });
    const provider = await WeblnLightning.connect({ enable: async () => {}, getInfo: async () => ({ network: "regtest" }), sendPayment }, "testnet");
    await expect(provider.payInvoice(fakeInvoice(1, new Uint8Array(32)))).rejects.toBeInstanceOf(NothingSpentError);
    expect(sendPayment).toHaveBeenCalledOnce();
  });

  it("not enough in the wallet is refused before it is asked to pay", async () => {
    const { provider, invoice, wallet } = await setup("pay", { balance: 10 });
    const send = vi.spyOn(wallet, "sendPayment");
    await expect(provider.payInvoice(invoice)).rejects.toThrow(/Not enough in the browser wallet \(10 sats\)/);
    expect(send).not.toHaveBeenCalled();
  });

  it("a lost answer, or one without proof, is unknown: never a refusal", async () => {
    for (const send of ["lost", "noproof"] as const) {
      const { provider, invoice, hash } = await setup(send);
      const error = await provider.payInvoice(invoice).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(NothingSpentError);
      // The wallet can be asked, and it did pay.
      expect(await provider.paymentStatus({ invoice, paymentHash: hash })).toMatchObject({ state: "paid" });
    }
  });

  it("a wallet that never answers, or a source closed while it waits, is unknown too", async () => {
    vi.useFakeTimers();
    try {
      const hang: WebLNProvider = { enable: async () => {}, getInfo: async () => ({ network: "regtest", methods: ["sendPayment"] }), sendPayment: () => new Promise(() => {}) };
      const provider = await WeblnLightning.connect(hang, "testnet");
      const paying = provider.payInvoice(fakeInvoice(5, new Uint8Array(32).fill(1))).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
      const error = await paying;
      expect(error).not.toBeInstanceOf(NothingSpentError);
      expect(String(error)).toMatch(/did not say whether it paid/);

      const controller = new AbortController();
      const again = await WeblnLightning.connect(hang, "testnet", controller.signal);
      const waiting = again.payInvoice(fakeInvoice(5, new Uint8Array(32).fill(2))).catch((e: unknown) => e);
      controller.abort();
      expect(await waiting).not.toBeInstanceOf(NothingSpentError);
    } finally { vi.useRealTimers(); }
  });

  it("WebLN has no word for failed: a payment the wallet does not show paid stays pending", async () => {
    const { provider, invoice, hash } = await setup("noroute");
    await provider.payInvoice(invoice).catch(() => {});
    await expect(provider.paymentStatus({ invoice, paymentHash: hash })).rejects.toThrow(/not found/);
    const wallet = new FakeWebln(undefined, {});
    const p = await WeblnLightning.connect(wallet, "testnet");
    const own = await p.createInvoice(3);
    expect(await p.paymentStatus({ invoice: own.invoice, paymentHash: own.paymentHash })).toEqual({ state: "pending" });
    expect(await p.invoiceStatus({ ...own, expiresAt: Date.now() - 1 })).toEqual({ state: "expired" });
  });
});

describe("the engine with a browser wallet as the Lightning source", () => {
  function service(wallet: WebLNProvider) {
    const events = { changed: vi.fn(), received: vi.fn(), resolved: vi.fn() } satisfies LightningEvents;
    const cashu = { view: async () => ({ balance: 0, mints: [], history: [], feesPaid: 0 }) } as unknown as CashuWallet;
    const descriptor = { ...webln, create: async (_: unknown, host: { mode: "mainnet" | "testnet"; signal: AbortSignal }) => WeblnLightning.connect(wallet, host.mode, host.signal) };
    return { events, lightning: new LightningService(() => [cashuMint, descriptor], () => ({ platform: "web", cashu }), events, CASHU_MINT_SOURCE) };
  }

  it("connects with nothing to store, and keeps its signal after replacing the mints", async () => {
    const { wallet, counterpart } = pair();
    const { lightning, events } = service(wallet);
    await lightning.start("testnet");
    await lightning.sources.set("webln", {});
    expect(lightning.view).toMatchObject({ providerId: "webln", status: "ready", network: "regtest", alias: "Fake WebLN", secrets: [] });
    // Receive: the invoice is the wallet's, seen paid through `lookupInvoice`.
    const invoice = await lightning.createInvoice(12, { paymentId: "req-1" });
    wallet.receive(invoice.paymentHash);
    await lightning.reconcile();
    expect(events.received).toHaveBeenCalledWith(expect.objectContaining({ paymentId: "req-1", providerId: "webln" }));
    // Pay: quoted (Ghostly's own fee ceiling: WebLN cannot say one), then paid once approved.
    const theirs = (await (await enabled(counterpart)).makeInvoice({ amount: 40 })).paymentRequest;
    const quote = await lightning.quote(theirs);
    expect(quote).toMatchObject({ amount: 40, feeReserve: 10, source: "webln" });
    expect(await lightning.pay(quote.quote)).toBe(true);
    expect((await lightning.list()).find((op) => op.direction === "out")).toMatchObject({ state: "paid", fee: 0 });
    await lightning.stop();
  });

  it("an unknown payment through a wallet that cannot look it up says so", async () => {
    const { wallet, counterpart } = pair({ send: "lost", methods: ["makeInvoice", "sendPayment", "getBalance"] });
    const { lightning } = service(wallet);
    await lightning.start("testnet");
    await lightning.sources.set("webln", {});
    const quote = await lightning.quote((await (await enabled(counterpart)).makeInvoice({ amount: 5 })).paymentRequest);
    expect(await lightning.pay(quote.quote)).toBe(false);
    expect((await lightning.list())[0]).toMatchObject({ state: "unknown", error: expect.stringMatching(/cannot be asked: check this payment in the wallet itself/) });
    await lightning.stop();
  });
});

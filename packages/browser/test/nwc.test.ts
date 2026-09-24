import "fake-indexeddb/auto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateSecretKey, type Event } from "nostr-tools/pure";
import { STORES, store, transact, wrap } from "../src/shared/idb";
import type { CashuWallet } from "../src/engine/wallet";
import { cashuMint, CASHU_MINT_SOURCE } from "../src/engine/paymentAdapters/providers/cashuMint";
import { LightningService, type LightningEvents } from "../src/engine/paymentAdapters/providers/lightningService";
import { NoAnswer, NwcLightning, nwc, parseNwcUri, type NwcOptions } from "../src/engine/paymentAdapters/providers/nwc";
import { LIGHTNING_PROVIDERS } from "../src/engine/paymentAdapters/providers/registry";
import { fakeInvoice } from "../src/engine/paymentAdapters/providers/testing";
import { NothingSpentError } from "../src/engine/paymentAdapters/providers/types";
import { FakeNwcWallet, TestRelay, type FakeNwcOptions } from "./helpers/fakeNwc";
import { describeLightningProvider } from "./helpers/providerContract";
// covers: wallet.lightning.nwc.connect, wallet.lightning.nwc.pay, wallet.lightning.provider-contract

let relay: TestRelay;
const opened: { close(): Promise<void> }[] = [];
beforeAll(async () => { relay = await TestRelay.start(); });
afterAll(async () => { await relay.close(); });
afterEach(async () => {
  for (const item of opened.splice(0)) await item.close().catch(() => {});
  relay.refuse = undefined; relay.silent = false;
  vi.restoreAllMocks();
});

async function wallet(options: FakeNwcOptions = {}) {
  const fake = await FakeNwcWallet.start(relay.url, options);
  opened.push(fake);
  return fake;
}
async function connect(fake: FakeNwcWallet, options: Parameters<typeof NwcLightning.connect>[1] = {}) {
  const provider = await NwcLightning.connect(fake.uri(), { requestMs: 1_500, payMs: 1_500, ...options });
  opened.push(provider);
  return provider;
}
const hash = () => crypto.getRandomValues(new Uint8Array(32));
// The contract every Lightning provider passes, against a fake NWC wallet service on a local relay: once
// with NIP-44, once with a wallet that only speaks NIP-04.
for (const [name, encryption] of [["NWC (NIP-44)", "nip44_v2 nip04"], ["NWC (NIP-04 only)", null]] as const) {
  describeLightningProvider(name, async () => {
    const mine = await wallet({ encryption });
    const other = await wallet();
    const provider = await connect(mine);
    return {
      provider, network: "regtest",
      payIncoming: async (invoice) => mine.markPaid(invoice.paymentHash),
      payable: async (amount) => other.makeInvoice(amount).invoice,
      refused: async () => other.makeInvoice(10_000_000).invoice,
    };
  });
}

describe("the NWC connection URI", () => {
  const pubkey = "a".repeat(64), secret = "b".repeat(64);
  it("reads the wallet, its relays and the secret", () => {
    const parsed = parseNwcUri(`nostr+walletconnect://${pubkey}?relay=wss%3A%2F%2Frelay.example.com&relay=ws://127.0.0.1:44502&secret=${secret}&lud16=a@b.c`);
    expect(parsed.walletPubkey).toBe(pubkey);
    expect(parsed.relays).toEqual(["wss://relay.example.com/", "ws://127.0.0.1:44502/"]);
    expect(parsed.secret).toHaveLength(32);
    expect(parseNwcUri(`nostr+walletconnect:${pubkey.toUpperCase()}?relay=wss://r.example&secret=${secret}`).walletPubkey).toBe(pubkey);
  });

  it("refuses what is not one, insecure relays and bad secrets, without repeating the URI", () => {
    const cases = [
      "https://example.com",
      `bunker://${pubkey}?relay=wss://r.example&secret=${secret}`,
      `nostr+walletconnect://${pubkey.slice(1)}?relay=wss://r.example&secret=${secret}`,
      `nostr+walletconnect://${pubkey}?relay=wss://r.example`,
      `nostr+walletconnect://${pubkey}?relay=wss://r.example&secret=${"0".repeat(64)}`,
      `nostr+walletconnect://${pubkey}?secret=${secret}`,
      `nostr+walletconnect://${pubkey}?relay=ws://relay.example.com&secret=${secret}`,
      `nostr+walletconnect://${pubkey}?relay=wss://user:pass@relay.example.com&secret=${secret}`,
      `nostr+walletconnect://${pubkey}?relay=wss://r.example&secret=${secret}&x=${"y".repeat(3000)}`,
    ];
    for (const uri of cases) {
      let message = "";
      try { parseNwcUri(uri); } catch (error) { message = (error as Error).message; }
      expect(message, uri.slice(0, 40)).not.toBe("");
      expect(message).not.toContain(secret);
    }
    expect(() => nwc.validate!({ config: {}, secrets: { uri: "lnbc1…" } }, "testnet")).toThrow("not a Nostr Wallet Connect URI");
  });

  it("is registered, offered in both modes and on every platform, with the URI as its one secret", () => {
    expect(LIGHTNING_PROVIDERS.map((d) => d.id)).toContain("nwc");
    expect(nwc.fields).toEqual([expect.objectContaining({ name: "uri", kind: "secret" })]);
    expect(nwc.platforms).toEqual(["web", "extension", "desktop"]);
    expect(nwc.networks).toContain("bitcoin");
    expect(nwc.networks).toContain("regtest");
    expect(nwc.description).toMatch(/custodial or not depends on the wallet/);
  });
});

describe("talking to the wallet", () => {
  it("speaks NIP-44 when the wallet offers it, and NIP-04 only when its info event says nothing else", async () => {
    const modern = await wallet();
    expect((await connect(modern)).encryption).toBe("nip44_v2");
    expect(modern.requests.every((r) => r.encryption === "nip44_v2")).toBe(true);
    const old = await wallet({ encryption: null });
    const provider = await connect(old);
    expect(provider.encryption).toBe("nip04");
    expect((await provider.info()).balance).toBe(100_000);
    expect(old.requests.map((r) => r.encryption)).toEqual(["nip04", "nip04"]);
    await expect(connect(await wallet({ encryption: "nip99" }))).rejects.toThrow("no encryption Ghostly speaks");
  });

  it("refuses a wallet that has published no info event", async () => {
    const uri = `nostr+walletconnect://${"c".repeat(64)}?relay=${encodeURIComponent(relay.url)}&secret=${"d".repeat(64)}`;
    await expect(NwcLightning.connect(uri, { infoMs: 500 })).rejects.toThrow("has not published its NWC info");
  });

  it("takes its network from get_info, Bitcoin when it does not say, and its capabilities from what this connection may do", async () => {
    expect((await (await connect(await wallet({ network: "mainnet" }))).info()).network).toBe("bitcoin");
    expect((await (await connect(await wallet({ network: "signet" }))).info()).network).toBe("signet");
    expect((await (await connect(await wallet({ network: null }))).info()).network).toBe("bitcoin");
    await expect(connect(await wallet({ network: "dogecoin" }))).rejects.toThrow("network Ghostly does not know");
    const receiveOnly = await connect(await wallet({ methods: ["get_info", "make_invoice", "lookup_invoice"] }));
    expect(receiveOnly.capabilities).toEqual({ receive: true, send: false, balance: false, lookup: true });
    await expect(receiveOnly.payInvoice(fakeInvoice(5, hash()), 10)).rejects.toBeInstanceOf(NothingSpentError);
    // Paying without looking up could leave a payment that nothing can ever settle: not offered.
    expect((await connect(await wallet({ methods: ["get_info", "pay_invoice", "get_balance"] }))).capabilities.send).toBe(false);
    // get_info in the service but not for this connection: connects, as a wallet without it would.
    const restricted = await wallet({ network: "regtest" });
    restricted.options.methods = ["get_balance", "make_invoice", "pay_invoice", "lookup_invoice"];
    const noInfo = await connect(restricted);
    expect((await noInfo.info()).network).toBe("bitcoin");
    expect(noInfo.capabilities.send).toBe(true);
    const info = await (await connect(await wallet({ alias: "Test hub" }))).info();
    expect(info.alias).toBe(`Test hub via ${new URL(relay.url).host}`);
  });

  it("reads only answers signed by the wallet, about its request, of the method asked, and not oversized", async () => {
    const fake = await wallet();
    const provider = await connect(fake);
    fake.mute = true;
    const before = relay.received.length;
    const balance = provider.info();
    await vi.waitFor(() => expect(relay.received.length).toBeGreaterThan(before));
    const request = relay.received.at(-1)!;
    expect(request.kind).toBe(23194);
    // Another key, another request, another method, a broken signature, a huge answer: all dropped.
    fake.respond(request, { result_type: "get_balance", result: { balance: 1_000 } }, { key: generateSecretKey() });
    fake.respond(request, { result_type: "get_balance", result: { balance: 2_000 } }, { tags: [["p", request.pubkey], ["e", "f".repeat(64)]] });
    fake.respond(request, { result_type: "get_info", result: { balance: 3_000 } });
    fake.respond(request, { result_type: "get_balance", result: { balance: 4_000 }, padding: "x".repeat(60_000) });
    const forged = fake.respond(request, { result_type: "get_balance", result: { balance: 5_000 } }, { send: false });
    relay.publish({ ...forged, id: forged.id.replace(/^./, forged.id[0] === "0" ? "1" : "0") } as Event);
    await new Promise((r) => setTimeout(r, 200));
    fake.respond(request, { result_type: "get_balance", result: { balance: 21_000 } });
    expect((await balance).balance).toBe(21);
  });

  it("gives up on an answer that does not come", async () => {
    const fake = await wallet();
    const provider = await connect(fake);
    fake.mute = true;
    await expect(provider.info()).rejects.toBeInstanceOf(NoAnswer);
  });

  it("refuses an invoice from the wallet that is not the one asked for", async () => {
    const fake = await wallet();
    const provider = await connect(fake);
    fake.mute = true;
    const before = relay.received.length;
    const created = provider.createInvoice(21);
    await vi.waitFor(() => expect(relay.received.length).toBeGreaterThan(before));
    fake.respond(relay.received.at(-1)!, { result_type: "make_invoice", result: { invoice: fakeInvoice(22, hash()), amount: 21_000 } });
    await expect(created).rejects.toThrow("does not match");
  });
});

describe("paying: nothing spent, or unknown and looked up", () => {
  async function payer(behaviour: FakeNwcOptions["behaviour"], options: FakeNwcOptions = {}) {
    const fake = await wallet({ behaviour, ...options });
    const payee = await wallet();
    const provider = await connect(fake);
    const incoming = payee.makeInvoice(30);
    return { fake, payee, provider, incoming, ref: { invoice: incoming.invoice, paymentHash: incoming.paymentHash } };
  }

  it("pays, with the wallet's fee and a preimage that proves it, and the request expires", async () => {
    const { fake, payee, provider, incoming, ref } = await payer("settle", { feeMsat: 1_500 });
    expect(await provider.payInvoice(incoming.invoice, 10)).toEqual({ state: "paid", fee: 2, preimage: incoming.preimage });
    expect(payee.balance).toBe(100_030);
    expect(fake.balance).toBe(99_968);
    expect(await provider.paymentStatus(ref)).toEqual({ state: "paid", fee: 2, preimage: incoming.preimage });
    const request = relay.received.filter((e) => e.kind === 23194).at(-2)!;
    const expiration = Number(request.tags.find((t) => t[0] === "expiration")?.[1]);
    expect(expiration - Date.now() / 1000).toBeGreaterThan(30);
    expect(expiration - Date.now() / 1000).toBeLessThan(120);
  });

  it.each(["INSUFFICIENT_BALANCE", "QUOTA_EXCEEDED", "RESTRICTED", "UNAUTHORIZED", "RATE_LIMITED", "NOT_IMPLEMENTED"])("%s, answered before paying, is nothing spent", async (code) => {
    const { provider, incoming } = await payer("refuse", { refuseCode: code });
    await expect(provider.payInvoice(incoming.invoice, 10)).rejects.toBeInstanceOf(NothingSpentError);
  });

  it("a request the relay refuses, or that finds no relay, is nothing spent: the wallet never saw it", async () => {
    const { fake, provider, incoming } = await payer("settle");
    relay.refuse = (event) => (event.kind === 23194 ? "blocked: test" : undefined);
    await expect(provider.payInvoice(incoming.invoice, 10)).rejects.toThrow(NothingSpentError);
    relay.refuse = undefined;
    expect(fake.requests.map((r) => r.method)).not.toContain("pay_invoice");
    await provider.close();
    await expect(provider.payInvoice(incoming.invoice, 10)).rejects.toBeInstanceOf(NothingSpentError);
  });

  it("PAYMENT_FAILED is nothing spent only once the wallet's record says failed", async () => {
    const failed = await payer("fail");
    await expect(failed.provider.payInvoice(failed.incoming.invoice, 10)).rejects.toBeInstanceOf(NothingSpentError);
    expect(await failed.provider.paymentStatus(failed.ref)).toEqual({ state: "failed" });
    const inFlight = await payer("timeout");
    expect(await inFlight.provider.payInvoice(inFlight.incoming.invoice, 10)).toEqual({ state: "pending" });
    expect(await inFlight.provider.paymentStatus(inFlight.ref)).toEqual({ state: "pending" });
  });

  it("a lost answer is unknown, and lookup_invoice finds it paid", async () => {
    const { provider, incoming, ref } = await payer("hang");
    const error = await provider.payInvoice(incoming.invoice, 10).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoAnswer);
    expect(error).not.toBeInstanceOf(NothingSpentError);
    expect(await provider.paymentStatus(ref)).toMatchObject({ state: "paid", preimage: incoming.preimage });
  });

  it("an error the wallet answers after trying (INTERNAL) is settled by its own record, never taken as nothing spent", async () => {
    const paid = await payer("internal");
    expect(await paid.provider.payInvoice(paid.incoming.invoice, 10)).toMatchObject({ state: "paid", preimage: paid.incoming.preimage });
    // No record at all: the payment may still start, so it is pending, not refused.
    const unknown = await payer("silent");
    const before = relay.received.length;
    const paying = unknown.provider.payInvoice(unknown.incoming.invoice, 10);
    await vi.waitFor(() => expect(relay.received.length).toBeGreaterThan(before));
    unknown.fake.respond(relay.received.at(-1)!, { result_type: "pay_invoice", error: { code: "INTERNAL", message: "FAILURE_REASON_ERROR" } });
    expect(await paying).toEqual({ state: "pending" });
  });

  it("an answer the relay never confirmed still counts", async () => {
    const { provider, incoming } = await payer("settle");
    relay.silent = true;
    expect(await provider.payInvoice(incoming.invoice, 10)).toMatchObject({ state: "paid" });
  });

  it("a payment the wallet never heard of stays pending until its invoice cannot be paid anymore", async () => {
    const { provider, incoming, ref } = await payer("silent");
    const error = await provider.payInvoice(incoming.invoice, 10).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoAnswer);
    expect(await provider.paymentStatus(ref)).toEqual({ state: "pending" });
    const later = Date.now() + 2 * 3600_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    expect(await provider.paymentStatus(ref)).toEqual({ state: "failed" });
  });

  it("'paid' with a preimage that does not prove it is not taken at its word", async () => {
    const { fake, provider, incoming } = await payer("settle");
    fake.mute = true;
    const before = relay.received.length;
    const paying = provider.payInvoice(incoming.invoice, 10).catch((e: unknown) => e);
    await vi.waitFor(() => expect(relay.received.length).toBeGreaterThan(before));
    fake.respond(relay.received.at(-1)!, { result_type: "pay_invoice", result: { preimage: "0".repeat(64) } });
    const error = await paying;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NothingSpentError);
  });

  it("reconnects to the relay when it dropped the connection", async () => {
    const { provider, incoming } = await payer("settle");
    relay.disconnectAll();
    await new Promise((r) => setTimeout(r, 300));
    expect(await provider.payInvoice(incoming.invoice, 10)).toMatchObject({ state: "paid" });
  });

  it("an invoice is looked up as open, then paid, and expired once past its time", async () => {
    const { fake: mine, provider } = await payer("settle");
    const invoice = await provider.createInvoice(12, "memo");
    expect(await provider.invoiceStatus(invoice)).toEqual({ state: "open" });
    mine.markPaid(invoice.paymentHash);
    expect(await provider.invoiceStatus(invoice)).toEqual({ state: "paid", amount: 12 });
    const other = await provider.createInvoice(13);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 3600_000);
    expect(await provider.invoiceStatus(other)).toEqual({ state: "expired" });
  });
});

describe("NWC as the engine's Lightning source", () => {
  const settings = async () => wrap<unknown[]>((await store(STORES.settings, "readonly")).getAll());
  afterEach(async () => { await transact([STORES.settings], (s) => { s[STORES.settings].clear(); }); });

  function service() {
    const events = { changed: vi.fn(), received: vi.fn(), resolved: vi.fn() } satisfies LightningEvents;
    const cashu = { view: async () => ({ balance: 0, mints: [], history: [], feesPaid: 0 }) } as unknown as CashuWallet;
    // The real descriptor, with time limits a test can wait for.
    const options: NwcOptions = { requestMs: 1_500, payMs: 1_500 };
    const descriptor = { ...nwc, create: async ({ secrets }: { secrets: Record<string, string> }, host: { signal: AbortSignal }) => NwcLightning.connect(secrets.uri, { ...options, signal: host.signal }) };
    return { events, lightning: new LightningService(() => [cashuMint, descriptor], () => ({ platform: "web", cashu }), events, CASHU_MINT_SOURCE) };
  }

  it("is set up from its URI (sealed, never shown), receives and pays, and a lost answer is reconciled, not paid again", async () => {
    const fake = await wallet({ alias: "Hub" });
    const payee = await wallet();
    const uri = fake.uri();
    const { lightning, events } = service();
    await lightning.start("testnet");
    await lightning.sources.set("nwc", { uri });
    expect(lightning.view).toMatchObject({ providerId: "nwc", status: "ready", network: "regtest", secrets: ["uri"], alias: expect.stringContaining("Hub via") });
    expect(JSON.stringify(lightning.view)).not.toContain(uri.split("secret=")[1]);
    expect(JSON.stringify(await settings())).not.toContain(uri.split("secret=")[1]);
    await vi.waitFor(() => expect(lightning.view.balance).toBe(100_000));

    const invoice = await lightning.createInvoice(40, { paymentId: "req-in" });
    fake.markPaid(invoice.paymentHash);
    await lightning.reconcile();
    expect(events.received).toHaveBeenCalledWith(expect.objectContaining({ paymentId: "req-in", providerId: "nwc" }));

    fake.behaviour = "hang";
    const bill = payee.makeInvoice(30);
    expect(await lightning.pay((await lightning.quote(bill.invoice)).quote, { paymentId: "req-out" })).toBe(false);
    expect((await lightning.list()).find((op) => op.direction === "out")).toMatchObject({ state: "unknown" });
    await expect(lightning.pay((await lightning.quote(bill.invoice)).quote)).rejects.toThrow("already being paid");
    await lightning.reconcile();
    expect(events.resolved).toHaveBeenCalledWith(expect.objectContaining({ paymentId: "req-out" }), true);
    expect(fake.outgoing.size).toBe(1);
    expect(payee.balance).toBe(100_030);
    await lightning.stop();
  });

  it("refuses a Mainnet wallet in Testnet before saving anything", async () => {
    const fake = await wallet({ network: "mainnet" });
    const { lightning } = service();
    await lightning.start("testnet");
    await expect(lightning.sources.set("nwc", { uri: fake.uri() })).rejects.toThrow("real money");
    expect(await settings()).toEqual([]);
    await lightning.stop();
  });
});

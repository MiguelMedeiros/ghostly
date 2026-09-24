import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { base64urlnopad } from "@scure/base";
import { decodeBolt11 } from "@ghostly/core";
import { CommandoError, CommandoTransportError } from "../src/engine/paymentAdapters/providers/commando";
import { CLN_METHODS, CoreLightning, checkRune, coreLightning, runeRestrictions, type ClnRpc } from "../src/engine/paymentAdapters/providers/coreLightning";
import { fakeInvoice } from "../src/engine/paymentAdapters/providers/testing";
import { NothingSpentError, type ProviderSettings } from "../src/engine/paymentAdapters/providers/types";
import { describeLightningProvider } from "./helpers/providerContract";
// covers: wallet.lightning.cln.connect, wallet.lightning.cln.pay, wallet.lightning.provider-contract

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
/** A rune as Core Lightning encodes one: 32 bytes of hash state, then its restrictions. */
const makeRune = (restrictions: string) => base64urlnopad.encode(concatBytes(random(32), utf8ToBytes(restrictions)));
const GOOD_RUNE = makeRune(`=0&${CLN_METHODS.map((m) => `method=${m}`).join("|")}`);
const NODE_ID = `02${"ab".repeat(32)}`;

type Pay = { payment_hash: string; status: "pending" | "complete" | "failed"; amount_msat: number; amount_sent_msat: number; preimage?: string };

/**
 * An in-memory Core Lightning, answering the RPC the provider makes as the real one does (shapes and error
 * codes seen on v26.06): the mocked transport of the contract suite and of the money-safety cases.
 */
class FakeCln implements ClnRpc {
  network = "regtest";
  id = NODE_ID;
  channels = [{ state: "CHANNELD_NORMAL", our_amount_msat: 500_000_000 }, { state: "ONCHAIN", our_amount_msat: 9_000_000 }];
  readonly invoices = new Map<string, { bolt11: string; payment_hash: string; expires_at: number; label: string; status: string; amount_received_msat?: number }>();
  readonly pays: Pay[] = [];
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  /** Overrides one method: throw a CommandoError / CommandoTransportError, or answer something else. */
  readonly override = new Map<string, (params: Record<string, unknown>) => unknown>();
  closed = false;

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    const custom = this.override.get(method);
    if (custom) return custom(params) as T;
    return this.run(method, params) as T;
  }

  private run(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case "getinfo": return { id: this.id, alias: "fake-cln", network: this.network };
      case "listfunds": return { channels: this.channels };
      case "invoice": {
        const preimage = random(32), hash = sha256(preimage);
        const bolt11 = fakeInvoice(Number(params.amount_msat) / 1000, hash, String(params.description));
        const invoice = { bolt11, payment_hash: bytesToHex(hash), expires_at: Math.floor(Date.now() / 1000) + Number(params.expiry), label: String(params.label), status: "unpaid" };
        this.invoices.set(invoice.payment_hash, invoice);
        return { bolt11, payment_hash: invoice.payment_hash, expires_at: invoice.expires_at };
      }
      case "listinvoices": return { invoices: [...this.invoices.values()].filter((i) => i.payment_hash === params.payment_hash) };
      case "listpays": return { pays: this.pays.filter((p) => p.payment_hash === params.payment_hash) };
      case "xpay": {
        const decoded = decodeBolt11(String(params.invstring))!;
        const hash = decoded.paymentHash!, amount = Number(decoded.amountMsat);
        if (this.pays.some((p) => p.payment_hash === hash && p.status === "complete")) throw new CommandoError(219, "xpay: Already paid this invoice successfully");
        const fee = Math.min(Number(params.maxfee), 1000);
        const spendable = this.channels.filter((c) => c.state === "CHANNELD_NORMAL").reduce((s, c) => s + c.our_amount_msat, 0);
        if (amount + fee > spendable) throw new CommandoError(205, "xpay: Failed: We could not find a usable set of paths.");
        const preimage = bytesToHex(random(32));
        this.pays.push({ payment_hash: hash, status: "complete", amount_msat: amount, amount_sent_msat: amount + fee, preimage });
        this.channels[0].our_amount_msat -= amount + fee;
        return { payment_preimage: preimage, amount_msat: amount, amount_sent_msat: amount + fee, failed_parts: 0, successful_parts: 1 };
      }
      default: throw new CommandoError(19537, `${method}: Invalid rune: Not permitted`);
    }
  }

  /** Someone paid our invoice. */
  markPaid(hash: string) { const i = this.invoices.get(hash)!; i.status = "paid"; i.amount_received_msat = Number(decodeBolt11(i.bolt11)!.amountMsat); }
  async close() { this.closed = true; }
}

const invoiceOf = (sats: number, expirySeconds = 3600) => { const hash = random(32); return { invoice: fakeInvoice(sats, hash, "", expirySeconds), paymentHash: bytesToHex(hash) }; };

describeLightningProvider("Core Lightning (mocked transport)", async () => {
  const node = new FakeCln();
  return {
    provider: new CoreLightning(node, NODE_ID), network: "regtest",
    payIncoming: async (invoice) => node.markPaid(invoice.paymentHash),
    payable: async (amount) => invoiceOf(amount).invoice,
    refused: async () => invoiceOf(10_000_000).invoice,
  };
});

describe("Core Lightning: what the node says", () => {
  it("reports its network, and a balance of the normal channels only", async () => {
    const node = new FakeCln();
    expect(await new CoreLightning(node, NODE_ID).info()).toEqual({ network: "regtest", alias: "fake-cln", balance: 500_000 });
    node.network = "testnet4";
    expect((await new CoreLightning(node, NODE_ID).info()).network).toBe("testnet");
    node.network = "bitcoin";
    expect((await new CoreLightning(node, NODE_ID).info()).network).toBe("bitcoin");
    node.network = "liquid";
    await expect(new CoreLightning(node, NODE_ID).info()).rejects.toThrow(/network Ghostly does not know/);
  });

  it("refuses a node that answers with another id", async () => {
    await expect(new CoreLightning(new FakeCln(), `03${"cd".repeat(32)}`).info()).rejects.toThrow(/another id/);
  });

  it("refuses an invoice from the node that is not the one asked for", async () => {
    const node = new FakeCln();
    node.override.set("invoice", () => ({ bolt11: invoiceOf(99).invoice, payment_hash: "00".repeat(32), expires_at: 0 }));
    await expect(new CoreLightning(node, NODE_ID).createInvoice(21)).rejects.toThrow(/does not match/);
  });

  it("creates invoices with a unique label and its memo, and reads their state", async () => {
    const node = new FakeCln(), provider = new CoreLightning(node, NODE_ID);
    const invoice = await provider.createInvoice(42, "for tea");
    expect(invoice.ref).toMatch(/^ghostly-/);
    expect(node.calls.find((c) => c.method === "invoice")?.params).toMatchObject({ amount_msat: 42_000, description: "for tea", expiry: 3600 });
    expect(await provider.invoiceStatus(invoice)).toEqual({ state: "open" });
    node.invoices.get(invoice.paymentHash)!.status = "expired";
    expect(await provider.invoiceStatus(invoice)).toEqual({ state: "expired" });
    await expect(provider.invoiceStatus({ ...invoice, paymentHash: "11".repeat(32) })).rejects.toThrow(/does not know/);
  });
});

describe("Core Lightning: money safety", () => {
  const pay = async (node: FakeCln, sats = 100) => {
    const { invoice, paymentHash } = invoiceOf(sats);
    return { invoice, paymentHash, result: new CoreLightning(node, NODE_ID).payInvoice(invoice, 10) };
  };

  it("pays with xpay under the fee cap, in msat", async () => {
    const node = new FakeCln();
    const { result } = await pay(node);
    await expect(result).resolves.toMatchObject({ state: "paid", fee: 1 });
    expect(node.calls.find((c) => c.method === "xpay")?.params).toMatchObject({ maxfee: 10_000, retry_for: 60 });
  });

  it("falls back to pay when xpay never ran (an older node, a rune without it)", async () => {
    for (const code of [-32601, 19537]) {
      const node = new FakeCln();
      node.override.set("xpay", () => { throw new CommandoError(code, "xpay: not here"); });
      node.override.set("pay", () => ({ payment_preimage: "aa".repeat(32), payment_hash: "", status: "complete", amount_msat: 100_000, amount_sent_msat: 100_500 }));
      await expect((await pay(node)).result).resolves.toMatchObject({ state: "paid", fee: 0 });
      expect(node.calls.find((c) => c.method === "pay")?.params).toMatchObject({ maxfee: 10_000 });
    }
  });

  it("a rune that allows neither is NothingSpentError", async () => {
    const node = new FakeCln();
    node.override.set("xpay", () => { throw new CommandoError(19537, "xpay: Invalid rune"); });
    node.override.set("pay", () => { throw new CommandoError(19537, "pay: Invalid rune"); });
    await expect((await pay(node)).result).rejects.toBeInstanceOf(NothingSpentError);
  });

  it("the node's refusal is NothingSpentError only when it has nothing out for that hash", async () => {
    const node = new FakeCln();
    await expect((await pay(node, 10_000_000)).result).rejects.toBeInstanceOf(NothingSpentError);
    // Every attempt failed back: still nothing spent.
    const failed = new FakeCln();
    failed.override.set("xpay", (params) => { failed.pays.push({ payment_hash: decodeBolt11(String(params.invstring))!.paymentHash!, status: "failed", amount_msat: 1, amount_sent_msat: 1 }); throw new CommandoError(210, "xpay: Failed after retries"); });
    await expect((await pay(failed)).result).rejects.toBeInstanceOf(NothingSpentError);
  });

  it("a refusal while a part is still out is pending, never failed", async () => {
    const node = new FakeCln();
    node.override.set("xpay", (params) => { node.pays.push({ payment_hash: decodeBolt11(String(params.invstring))!.paymentHash!, status: "pending", amount_msat: 1, amount_sent_msat: 1 }); throw new CommandoError(210, "xpay: timed out"); });
    await expect((await pay(node)).result).resolves.toEqual({ state: "pending", ref: expect.any(String) });
  });

  it("an invoice the node already paid is paid, not paid again", async () => {
    const node = new FakeCln();
    const { invoice } = invoiceOf(100);
    const provider = new CoreLightning(node, NODE_ID);
    await provider.payInvoice(invoice, 10);
    const balance = (await provider.info()).balance;
    await expect(provider.payInvoice(invoice, 10)).resolves.toMatchObject({ state: "paid" });
    expect((await provider.info()).balance).toBe(balance);
  });

  it("a refusal it cannot check is an unknown outcome, not NothingSpentError", async () => {
    const node = new FakeCln();
    node.override.set("xpay", () => { throw new CommandoError(210, "xpay: failed"); });
    node.override.set("listpays", () => { throw new CommandoTransportError("dropped", true); });
    const error = await (await pay(node)).result.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NothingSpentError);
  });

  it("no answer is unknown, or pending / paid when the node already shows it", async () => {
    const lost = () => { throw new CommandoTransportError("The node did not answer xpay in time", true); };
    const node = new FakeCln();
    node.override.set("xpay", lost);
    const error = await (await pay(node)).result.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandoTransportError);
    expect(error).not.toBeInstanceOf(NothingSpentError);

    const inFlight = new FakeCln();
    inFlight.override.set("xpay", (params) => { inFlight.pays.push({ payment_hash: decodeBolt11(String(params.invstring))!.paymentHash!, status: "pending", amount_msat: 1, amount_sent_msat: 1 }); return lost(); });
    await expect((await pay(inFlight)).result).resolves.toMatchObject({ state: "pending" });

    const done = new FakeCln();
    done.override.set("xpay", (params) => { done.pays.push({ payment_hash: decodeBolt11(String(params.invstring))!.paymentHash!, status: "complete", amount_msat: 100_000, amount_sent_msat: 101_000, preimage: "bb".repeat(32) }); return lost(); });
    await expect((await pay(done)).result).resolves.toEqual({ state: "paid", fee: 1, preimage: "bb".repeat(32), ref: expect.any(String) });
  });

  it("a connection that never opened sent nothing: NothingSpentError", async () => {
    const node = new FakeCln();
    node.override.set("xpay", () => { throw new CommandoTransportError("Could not reach the node at that address", false); });
    await expect((await pay(node)).result).rejects.toBeInstanceOf(NothingSpentError);
  });

  it("refuses an invoice it cannot read (or with no amount) before asking the node", async () => {
    const node = new FakeCln();
    const amountless = fakeInvoice(1, random(32)).replace(/^lnbcrt10n/, "lnbcrt");
    await expect(new CoreLightning(node, NODE_ID).payInvoice(amountless, 10)).rejects.toBeInstanceOf(NothingSpentError);
    expect(node.calls).toHaveLength(0);
  });

  it("reconciles by payment hash: never failed while the invoice could still be paid", async () => {
    const node = new FakeCln(), provider = new CoreLightning(node, NODE_ID);
    const live = invoiceOf(100), expired = invoiceOf(100, 1);
    expect(await provider.paymentStatus(live)).toEqual({ state: "pending" });
    await new Promise((r) => setTimeout(r, 1100));
    expect(await provider.paymentStatus(expired)).toEqual({ state: "failed" });
    node.pays.push({ payment_hash: live.paymentHash, status: "failed", amount_msat: 1, amount_sent_msat: 1 });
    expect(await provider.paymentStatus(live)).toEqual({ state: "failed" });
    node.pays.push({ payment_hash: live.paymentHash, status: "pending", amount_msat: 1, amount_sent_msat: 1 });
    expect(await provider.paymentStatus(live)).toEqual({ state: "pending" });
    node.pays.push({ payment_hash: live.paymentHash, status: "complete", amount_msat: 100_000, amount_sent_msat: 100_002, preimage: "cc".repeat(32) });
    expect(await provider.paymentStatus(live)).toEqual({ state: "paid", fee: 0, preimage: "cc".repeat(32) });
    expect(node.calls.filter((c) => c.method === "listpays").every((c) => c.params.payment_hash === live.paymentHash || c.params.payment_hash === expired.paymentHash)).toBe(true);
  });
});

describe("Core Lightning: runes and the form", () => {
  it("reads a rune's restrictions, escapes included", () => {
    expect(runeRestrictions(makeRune("=0&method=getinfo|method=invoice&rate=60"))).toEqual([["=0"], ["method=getinfo", "method=invoice"], ["rate=60"]]);
    expect(runeRestrictions(makeRune("method=a\\|b"))).toEqual([["method=a|b"]]);
    expect(() => runeRestrictions("not a rune!")).toThrow(/not a rune/);
    expect(() => runeRestrictions(base64urlnopad.encode(random(8)))).toThrow(/not a rune/);
  });

  it("takes only a rune limited to Ghostly's methods", () => {
    expect(() => checkRune(GOOD_RUNE)).not.toThrow();
    expect(() => checkRune(makeRune("=0&method=getinfo|method=listfunds&rate=10"))).not.toThrow();
    for (const bad of ["=0", "=0&rate=60", "=0&method=getinfo|method=withdraw", "=0&method^list", "=0&method=getinfo|#anything", "=0&method/withdraw", "=0&method=invoice\\|withdraw"]) {
      expect(() => checkRune(makeRune(bad)), bad).toThrow(/createrune/);
    }
  });

  it("validates the form before anything is contacted", () => {
    const settings = (config: Record<string, string>, rune = GOOD_RUNE): ProviderSettings => ({ config: { nodeId: NODE_ID, url: "wss://node.example.com", ...config }, secrets: { rune } });
    expect(() => coreLightning.validate!(settings({}), "testnet")).not.toThrow();
    expect(() => coreLightning.validate!(settings({ url: "ws://127.0.0.1:9736" }), "testnet")).not.toThrow();
    expect(() => coreLightning.validate!(settings({ nodeId: "02abc" }), "testnet")).toThrow(/66 hex/);
    expect(() => coreLightning.validate!(settings({ url: "https://node.example.com" }), "testnet")).toThrow(/wss:\/\//);
    expect(() => coreLightning.validate!(settings({ url: "node.example.com" }), "testnet")).toThrow(/wss:\/\//);
    expect(() => coreLightning.validate!(settings({ url: "wss://user:pass@node.example.com" }), "testnet")).toThrow(/own field/);
    expect(() => coreLightning.validate!(settings({}, makeRune("=0")), "testnet")).toThrow(/not restricted/);
  });

  it("declares the rune a secret, and runs on every platform in both modes", () => {
    expect(coreLightning.fields.find((f) => f.name === "rune")?.kind).toBe("secret");
    expect(coreLightning.fields.filter((f) => f.kind === "secret")).toHaveLength(1);
    expect(coreLightning.platforms).toEqual(["web", "extension", "desktop"]);
    expect(coreLightning.networks).toContain("bitcoin");
    expect(coreLightning.networks).toContain("regtest");
  });
});

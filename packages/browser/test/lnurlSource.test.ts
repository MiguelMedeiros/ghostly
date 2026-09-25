import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { STORES, transact } from "../src/shared/idb";
import type { CashuWallet } from "../src/engine/wallet";
import { cashuMint, CASHU_MINT_SOURCE } from "../src/engine/paymentAdapters/providers/cashuMint";
import { LightningService, type LightningEvents } from "../src/engine/paymentAdapters/providers/lightningService";
import { FakeLightningProvider, fakeLightning } from "../src/engine/paymentAdapters/providers/testing";
import { testInvoice } from "../../core/test/invoice";
// covers: wallet.lnurl.address, wallet.lnurl.protocol

/**
 * A Lightning address through the engine's Lightning service: resolved once, an invoice fetched for the
 * amount chosen, checked against the service's network, then quoted and paid like any pasted invoice.
 */

const METADATA = JSON.stringify([["text/plain", "Coffee for alice"], ["text/identifier", "alice@ln.example.com"]]);
const hash = () => sha256(new TextEncoder().encode(METADATA));

function fakeFetch(invoice: (amountSat: number) => string) {
  const asked: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    asked.push(url.href);
    if (url.pathname === "/.well-known/lnurlp/alice") return Response.json({ tag: "payRequest", callback: "https://ln.example.com/cb", minSendable: 1000, maxSendable: 50_000_000, metadata: METADATA, commentAllowed: 32 });
    if (url.pathname === "/cb") return Response.json({ pr: invoice(Number(url.searchParams.get("amount")) / 1000), successAction: { tag: "message", message: `thanks ${url.searchParams.get("comment") ?? ""}`.trim() } });
    return new Response("nope", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, asked };
}

function service(fetch: typeof globalThis.fetch, network: "mainnet" | "testnet", fake = new FakeLightningProvider({ balance: 10_000 })) {
  const events = { changed: vi.fn(), received: vi.fn(), resolved: vi.fn() } satisfies LightningEvents;
  const cashu = { view: async () => ({ balance: 7, mints: [], history: [], feesPaid: 0 }) } as unknown as CashuWallet;
  const descriptor = { ...fakeLightning, create: async () => fake };
  return { fake, lightning: new LightningService(network, () => [cashuMint, descriptor], () => ({ platform: "web", cashu }), events, CASHU_MINT_SOURCE, { fetch }) };
}

beforeEach(async () => { await transact([STORES.settings], (s) => { s[STORES.settings].clear(); }); });

describe("a Lightning address as a payment destination", () => {
  it("resolves to what a person sees, then fetches and checks the invoice for the amount chosen, and pays it through the source", async () => {
    const { fetch, asked } = fakeFetch((sats) => testInvoice({ sats, descriptionHash: hash(), prefix: "lnbcrt" }));
    const { lightning, fake } = service(fetch, "testnet");
    await lightning.start();
    await lightning.sources.set("fake-lightning", { token: "t", behaviour: "settle" });
    const view = await lightning.resolveDestination("Alice@LN.example.com");
    expect(view).toMatchObject({ kind: "address", text: "alice@ln.example.com", domain: "ln.example.com", callbackDomain: "ln.example.com", minSat: 1, maxSat: 50_000, description: "Coffee for alice", commentAllowed: 32 });
    const { invoice, successAction, note } = await lightning.destinationInvoice(view.id, 250, "gm");
    expect(asked).toEqual(["https://ln.example.com/.well-known/lnurlp/alice", "https://ln.example.com/cb?amount=250000&comment=gm"]);
    expect(successAction).toEqual({ tag: "message", message: "thanks gm" });
    expect(note).toBe("alice@ln.example.com");
    const quote = await lightning.quote(invoice);
    expect(quote.amount).toBe(250);
    expect(await lightning.pay(quote.quote, { note })).toBe(true);
    expect(fake.paid).toHaveLength(1);
    expect((await lightning.list()).find((op) => op.direction === "out")).toMatchObject({ amount: 250, state: "paid", note: "alice@ln.example.com" });
  });

  it("a Mainnet service refuses an invoice of a test network, and one the service made for another amount", async () => {
    const { fetch } = fakeFetch((sats) => testInvoice({ sats, descriptionHash: hash(), prefix: "lnbcrt" }));
    const { lightning } = service(fetch, "mainnet");
    await lightning.start();
    const view = await lightning.resolveDestination("alice@ln.example.com");
    await expect(lightning.destinationInvoice(view.id, 250)).rejects.toThrow(/regtest, a test network/);
    const wrong = fakeFetch((sats) => testInvoice({ sats: sats + 1, descriptionHash: hash() }));
    const other = service(wrong.fetch, "mainnet").lightning;
    await other.start();
    const again = await other.resolveDestination("alice@ln.example.com");
    await expect(other.destinationInvoice(again.id, 250)).rejects.toThrow(/asks for 251 sats, not the 250 sats/);
  });

  it("keeps a resolution only for a while, and only so many", async () => {
    const started = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(started);
    try {
      const { fetch } = fakeFetch((sats) => testInvoice({ sats, descriptionHash: hash() }));
      const { lightning } = service(fetch, "mainnet");
      await lightning.start();
      const first = await lightning.resolveDestination("alice@ln.example.com");
      clock.mockReturnValue(started + 11 * 60_000);
      await expect(lightning.destinationInvoice(first.id, 5)).rejects.toThrow(/resolved too long ago/);
      await expect(lightning.destinationInvoice("nope", 5)).rejects.toThrow(/resolved too long ago/);
      const ids: string[] = [];
      for (let i = 0; i < 21; i++) ids.push((await lightning.resolveDestination("alice@ln.example.com")).id);
      await expect(lightning.destinationInvoice(ids[0], 5)).rejects.toThrow(/resolved too long ago/);
      await expect(lightning.destinationInvoice(ids[20], 5)).resolves.toMatchObject({ note: "alice@ln.example.com" });
    } finally { clock.mockRestore(); }
  });
});

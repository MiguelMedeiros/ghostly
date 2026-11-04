import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Amount, type Proof } from "@cashu/cashu-ts";
import { CashuWallet, type WalletEvents } from "../src/engine/wallet";
import type { StoredQuote } from "../src/shared/types";
import { idbModule, mint, resetDb, rows } from "./fakes";
// covers: wallet.cashu.receive-lightning

/**
 * agents#2447: an open invoice of ours is asked about often while someone is likely paying it, then less and less, until
 * its mint lets it go. Before, every open quote was asked about every 4 s for the whole hour a cdk mint keeps it open.
 */

vi.mock("../src/shared/idb", async () => (await import("./fakes")).idbModule);
vi.mock("@cashu/cashu-ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cashu/cashu-ts")>()),
  Wallet: (await import("./fakes")).FakeWallet,
}));

const MINT = "https://mint.example";
const KEYSET = "009a1f293253e41e";
const C = `02${"ab".repeat(32)}`;
const INVOICE = "lnbc1000n1pinvoiceofours";
const HOUR = 3_600_000;
const proof = (amount: number, secret: string): Proof => ({ id: KEYSET, amount: Amount.from(amount), secret, C }) as Proof;

function setup(closed = new Set<string>()) {
  const events = { onChange: vi.fn(), onTestMintNeeded: vi.fn(async () => {}), onQuotePaid: vi.fn(), onMeltResolved: vi.fn(), requestClosed: (id: string) => closed.has(id) } satisfies WalletEvents;
  const wallet = new CashuWallet(() => [MINT], events);
  return { wallet, events, closed };
}
const asked = () => mint.checkMintQuoteBolt11.mock.calls.length;

beforeEach(() => {
  resetDb();
  vi.clearAllMocks();
  vi.useFakeTimers();
  // A cdk mint (mintd 0.17.7) keeps a quote open for an hour; nobody pays it.
  let n = 0;
  mint.createMintQuoteBolt11.mockImplementation(async () => ({ quote: `q${++n}`, request: n === 1 ? INVOICE : `${INVOICE}${n}`, expiry: Math.floor(Date.now() / 1000) + 3600, state: "UNPAID" }));
  mint.checkMintQuoteBolt11.mockResolvedValue({ state: "UNPAID" });
});
afterEach(() => { vi.useRealTimers(); });

describe("an invoice of ours nobody pays (agents#2447)", () => {
  it("is asked about about a hundred times in its hour, not every 4 s, and goes once it expired", async () => {
    const { wallet } = setup();
    await wallet.receiveLightning(100);
    await vi.advanceTimersByTimeAsync(HOUR + 3 * 60_000);
    if (process.env.INVOICE_PACE) console.log(`one unpaid mint quote, one hour: ${asked()} checks`);
    expect(asked()).toBeLessThan(110);
    expect(asked()).toBeGreaterThan(60);
    expect(rows<StoredQuote>("quotes"), "dropped once its mint said unpaid after its expiry").toEqual([]);
    await wallet.stop();
  });

  it("is asked about every 4 s in its first two minutes", async () => {
    const { wallet } = setup();
    await wallet.receiveLightning(100);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(asked()).toBeGreaterThanOrEqual(28);
    await wallet.stop();
  });

  it("paid after half an hour, shows within the slow pace (a minute)", async () => {
    const { wallet, events } = setup();
    await wallet.receiveLightning(100);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    mint.checkMintQuoteBolt11.mockResolvedValue({ state: "PAID" });
    mint.mintProofsBolt11.mockResolvedValue([proof(64, "a"), proof(32, "b"), proof(4, "c")]);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(events.onQuotePaid).toHaveBeenCalledOnce();
    await wallet.stop();
  });
});

describe("an invoice on screen (agents#2447)", () => {
  it("is asked about every 4 s while the screen watches it: a payment shows within seconds", async () => {
    const { wallet, events } = setup();
    await wallet.receiveLightning(100);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(await wallet.watch(INVOICE)).toBe(true);
    const before = asked();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(asked() - before, "fast while watched").toBeGreaterThanOrEqual(9);
    mint.checkMintQuoteBolt11.mockResolvedValue({ state: "PAID" });
    mint.mintProofsBolt11.mockResolvedValue([proof(64, "a"), proof(32, "b"), proof(4, "c")]);
    await vi.advanceTimersByTimeAsync(4_001);
    expect(events.onQuotePaid).toHaveBeenCalledOnce();
    expect(rows<StoredQuote>("quotes")).toEqual([]);
    await wallet.stop();
  });

  it("goes back to the slow pace once the screen stops saying it watches", async () => {
    const { wallet } = setup();
    await wallet.receiveLightning(100);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await wallet.watch(INVOICE);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    const before = asked();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(asked() - before).toBeLessThanOrEqual(11);
    await wallet.stop();
  });

  it("is not asked about again by a watch right after it was asked", async () => {
    const { wallet } = setup();
    await wallet.receiveLightning(100);
    await vi.advanceTimersByTimeAsync(4_000);
    const before = asked();
    await wallet.watch(INVOICE);
    await wallet.watch(INVOICE);
    expect(asked()).toBe(before);
    expect(await wallet.watch("lnbc1other")).toBe(false);
    await wallet.stop();
  });
});

describe("the invoice of a chat request that was closed (agents#2447)", () => {
  it("is asked about no more until it expired, then once, and goes", async () => {
    const { wallet, closed } = setup();
    await wallet.receiveLightning(100, "request-1");
    await vi.advanceTimersByTimeAsync(60_000);
    closed.add("request-1");
    mint.checkMintQuoteBolt11.mockClear();
    await vi.advanceTimersByTimeAsync(HOUR + 3 * 60_000);
    if (process.env.INVOICE_PACE) console.log(`closed request's quote, the rest of its hour: ${asked()} checks`);
    expect(asked()).toBe(1);
    expect(rows<StoredQuote>("quotes")).toEqual([]);
    await wallet.stop();
  });

  it("is still claimed when its payer paid it all the same", async () => {
    const { wallet, events, closed } = setup();
    await wallet.receiveLightning(100, "request-1");
    closed.add("request-1");
    mint.checkMintQuoteBolt11.mockResolvedValue({ state: "PAID" });
    mint.mintProofsBolt11.mockResolvedValue([proof(64, "a"), proof(32, "b"), proof(4, "c")]);
    // The payer's "I paid" asks at once, whatever the pace.
    expect(await wallet.vouch(INVOICE)).toBe(true);
    expect(events.onQuotePaid).toHaveBeenCalledOnce();
    await wallet.stop();
  });
});

describe("a payer's \"I paid\" for one invoice of a wallet with 100 open", () => {
  it("asks the mint about that invoice alone, then at the fast pace a while; the others keep theirs", async () => {
    const { wallet, events } = setup();
    for (let i = 0; i < 100; i++) await wallet.receiveLightning(100 + i);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    mint.checkMintQuoteBolt11.mockClear();
    expect(await wallet.vouch(INVOICE)).toBe(true);
    if (process.env.INVOICE_PACE) console.log(`one "I paid", 100 open mint quotes: ${asked()} checks`);
    expect(mint.checkMintQuoteBolt11.mock.calls.map(([quote]) => quote)).toEqual(["q1"]);
    // Named by the payer or not, only this one.
    expect(await wallet.vouch(INVOICE, false)).toBe(true);
    expect(asked()).toBe(2);
    mint.checkMintQuoteBolt11.mockImplementation(async (quote: string) => ({ state: quote === "q1" ? "PAID" : "UNPAID" }));
    mint.mintProofsBolt11.mockResolvedValue([proof(64, "a"), proof(32, "b"), proof(4, "c")]);
    await vi.advanceTimersByTimeAsync(4_001);
    expect(events.onQuotePaid, "fast while the payment settles").toHaveBeenCalledOnce();
    await wallet.stop();
  });
});

describe("a round of the poll (agents#2447)", () => {
  it("reads the quotes store once", async () => {
    const { wallet } = setup();
    await wallet.receiveLightning(100);
    await wallet.receiveLightning(200);
    await vi.advanceTimersByTimeAsync(4_000);
    // Every read of the whole quotes store.
    let reads = 0;
    const open = idbModule.store;
    const spy = vi.spyOn(idbModule, "store").mockImplementation(async (name: string) => {
      const opened = await open(name);
      if (name !== "quotes") return opened;
      return Object.assign(Object.create(opened) as typeof opened, { getAll: () => { reads++; return opened.getAll(); } });
    });
    const before = asked();
    await wallet.checkQuotes();
    spy.mockRestore();
    expect(asked() - before).toBe(2);
    expect(reads).toBe(1);
    await wallet.stop();
  });
});

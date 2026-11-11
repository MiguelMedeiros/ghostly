import { describe, expect, it } from "vitest";
import type { WalletView } from "@ghostly/browser/shared/types";
import { walletCards } from "../../components/walletCardData";
import { sharedBalanceCards, sharedSources, walletTotals } from "../../components/walletTotals";
import type { Translate } from "../../contexts/I18nContext";
import type { WalletNetwork, WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { arkReady, barkReady, bitcoinSource, lightningSource, mint, REAL_MINT, sparkReady, TEST_MINT, usdtReady } from "../payments/fixtures";

// covers: wallet.balance.total

/** The totals of one network, from a wallet as the engine shows it (the flat fields land on their own networks). */
const totalsOf = (wallet: Partial<WalletView> & { mode?: WalletNetwork }, network: WalletNetwork, edit?: (state: WalletState) => WalletState) => {
  const state = (edit ?? ((s) => s))(walletView(wallet) as WalletState);
  return walletTotals(state, network, walletCards(state));
};
/** Each row as `id: state amount`, the way a person reads the breakdown. */
const rows = (total: { rows: { id: string; state: string; amount?: number | bigint }[] } | undefined) =>
  total?.rows.map((r) => `${r.id}: ${r.state}${r.amount === undefined ? "" : ` ${r.amount}`}`);

const federation = (patch: Record<string, unknown> = {}) => ({ id: "ab".repeat(32), name: "Fed", guardians: [], consensusVersion: "2.1", network: "regtest", modules: [], joinedAt: 1, invite: "fed11qq", balance: 0, status: "ready" as const, lightning: true, read: true as const, ...patch });

describe("one balance per currency", () => {
  it("sums every Bitcoin card of the network, in the deck's order; Lightning through the mints is Cashu's balance, counted once", () => {
    const totals = totalsOf({
      mints: [mint(REAL_MINT, 1_000)], balance: 1_000,
      bitcoin: bitcoinSource({ read: true, balance: 10_000 }),
    }, "mainnet");
    expect(rows(totals.bitcoin)).toEqual(["cashu:mainnet: counted 1000", "lightning:mainnet: shared 1000", "bitcoin:mainnet: counted 10000"]);
    expect(totals.bitcoin).toMatchObject({ network: "mainnet", total: 11_000, ready: 11_000, uncounted: 0 });
    expect(totals.bitcoin?.rows[0]).toMatchObject({ note: "mint" });
    expect(totals.bitcoin?.rows[1]).toMatchObject({ sharedWith: "Cashu" });
    expect(totals.usdt).toBeUndefined();
  });

  it("counts a Lightning card with its own source beside Cashu, and Ark, Bark, Spark and Fedimint with theirs", () => {
    const totals = totalsOf({
      mints: [mint(TEST_MINT, 500)], balance: 500,
      lightning: lightningSource({ mode: "testnet", network: "regtest", read: true, balance: 2_000 }),
      ark: arkReady({ read: true }), bark: barkReady({ read: true }), spark: sparkReady({ read: true }),
      fedimint: { federations: [federation({ balance: 700 }), federation({ id: "cd".repeat(32), balance: 300 })], balance: 1_000, history: [] } as unknown as WalletView["fedimint"],
    }, "testnet");
    expect(rows(totals.bitcoin)).toEqual(["cashu:testnet: counted 500", "lightning:testnet: counted 2000", "arkade:testnet: counted 5000", "bark:testnet: counted 3000", "spark:testnet: counted 4000", "fedimint:testnet: counted 1000"]);
    expect(totals.bitcoin).toMatchObject({ total: 15_500, ready: 15_500, uncounted: 0 });
    expect(totals.bitcoin?.rows.find((r) => r.rail === "fedimint")).toMatchObject({ note: "federation" });
  });

  it("counts unconfirmed on-chain sats in the total but not in what is ready now; an Ark deposit or a Bark round on its way the same", () => {
    const totals = totalsOf({
      bitcoin: bitcoinSource({ mode: "testnet", network: "regtest", read: true, balance: 170_000, unconfirmed: 40_000 }),
      ark: arkReady({ read: true, balance: 1_000, incoming: 2_000 }),
      bark: barkReady({ read: true, balance: 0, pending: 500 }),
    }, "testnet");
    expect(rows(totals.bitcoin)).toEqual(["arkade:testnet: counted 3000", "bark:testnet: counted 500", "bitcoin:testnet: counted 210000"]);
    expect(totals.bitcoin?.rows.find((r) => r.rail === "bitcoin")).toMatchObject({ pending: 40_000, note: "unconfirmed" });
    expect(totals.bitcoin?.rows.find((r) => r.rail === "arkade")).toMatchObject({ pending: 2_000, note: "waiting" });
    expect(totals.bitcoin).toMatchObject({ total: 213_500, ready: 171_000 });
  });

  it("counts Cashu sats set aside for a payment the mint has not answered as not spendable yet, as Bark's send on its way out; they leave once paid, or come back spendable", () => {
    // Cashu: 1,000 spendable, 4,000 set aside for a payment. Bark: 1,000 spendable, 4,000 on their way out.
    const cashu = (balance: number, setAside: number) => totalsOf({
      mints: [mint(TEST_MINT, balance)], balance, setAside,
      bark: barkReady({ read: true, balance: 1_000, pending: 4_000 }),
    }, "testnet", (s) => ({ ...s, networks: { ...s.networks!, testnet: { ...s.networks!.testnet, setAside } } }));
    const pending = cashu(1_000, 4_000);
    expect(pending.bitcoin).toMatchObject({ total: 10_000, ready: 2_000 });
    expect(rows(pending.bitcoin)).toEqual(["cashu:testnet: counted 5000", "lightning:testnet: shared 5000", "bark:testnet: counted 5000"]);
    expect(pending.bitcoin?.rows[0]).toMatchObject({ pending: 4_000, note: "waiting" });
    expect(pending.bitcoin?.rows[2]).toMatchObject({ pending: 4_000, note: "waiting" });
    // The mint answered: paid, the set-aside sats are gone; failed, they are back in the balance, spendable.
    const paid = cashu(1_000, 0), failed = cashu(5_000, 0);
    expect(paid.bitcoin).toMatchObject({ total: 6_000, ready: 2_000 });
    expect(paid.bitcoin?.rows[0]).toEqual({ id: "cashu:testnet", rail: "cashu", name: "Cashu", state: "counted", amount: 1_000, note: "mint" });
    expect(failed.bitcoin).toMatchObject({ total: 10_000, ready: 6_000 });
    expect(failed.bitcoin?.rows[0]).toEqual({ id: "cashu:testnet", rail: "cashu", name: "Cashu", state: "counted", amount: 5_000, note: "mint" });
  });

  it("never counts a balance it could not read as 0: the card is a row with no amount, out of the total, and counted as such", () => {
    const base = { mints: [mint(TEST_MINT, 500)], balance: 500 };
    // A source that failed, one reconnecting with its last balance, one connected that has not read yet, a read that failed.
    for (const bitcoin of [
      bitcoinSource({ mode: "testnet", status: "error", balance: undefined, error: "Could not connect" }),
      bitcoinSource({ mode: "testnet", status: "connecting", read: true, balance: 50_000, balanceAt: 1 }),
      bitcoinSource({ mode: "testnet", status: "ready", balance: 50_000 }),
      bitcoinSource({ mode: "testnet", status: "ready", read: true, balance: 50_000, error: "Could not read the balance: timeout" }),
    ]) {
      const totals = totalsOf({ ...base, bitcoin }, "testnet");
      expect(totals.bitcoin?.rows.find((r) => r.rail === "bitcoin"), JSON.stringify(bitcoin)).toEqual({ id: "bitcoin:testnet", rail: "bitcoin", name: "Bitcoin", state: "unknown" });
      expect(totals.bitcoin).toMatchObject({ total: 500, ready: 500, uncounted: 1 });
    }
    // A wallet not read since it opened, a locked one, a federation that did not answer.
    const more = totalsOf({ ...base, ark: arkReady(), usdt: usdtReady({ read: true, locked: true }),
      fedimint: { federations: [federation({ balance: 700 }), federation({ id: "cd".repeat(32), read: undefined, status: "error" })], balance: 700, history: [] } as unknown as WalletView["fedimint"] }, "testnet");
    expect(rows(more.bitcoin)).toEqual(["cashu:testnet: counted 500", "lightning:testnet: shared 500", "arkade:testnet: unknown", "fedimint:testnet: unknown"]);
    expect(more.bitcoin).toMatchObject({ total: 500, uncounted: 2 });
    expect(more.usdt).toMatchObject({ total: 0n, uncounted: 1 });
  });

  it("leaves a wallet at home on another device out, saying where; a wallet not set up holds nothing and is not unknown", () => {
    const totals = totalsOf({ ark: arkReady({ read: true }), spark: sparkReady({ read: true }), bitcoin: bitcoinSource({ mode: "testnet", status: "none", providerId: "bdk", balance: undefined }) }, "testnet",
      (s) => ({ ...s, wallets: s.wallets!.map((w) => w.type === "arkade" ? { ...w, home: { device: "Phone" } } : w) }));
    expect(rows(totals.bitcoin)).toEqual(["arkade:testnet: away", "spark:testnet: counted 4000", "bitcoin:testnet: none"]);
    expect(totals.bitcoin?.rows[0]).toMatchObject({ device: "Phone" });
    expect(totals.bitcoin).toMatchObject({ total: 4_000, uncounted: 1 });
  });

  // What the engine says of a Breez Lightning card that opened the Spark wallet's own Breez database: it is that wallet.
  const breez = (balance: number, same?: "same wallet") =>
    ({ ...lightningSource({ mode: "testnet", network: "regtest", providerId: "breez", label: "Breez", read: true, balance }), ...(same ? { sameWalletAs: "spark" as const } : {}) });

  it("counts a Breez Lightning card that is the Spark wallet once, as the engine says, even when the two read different amounts", () => {
    // One wallet read at two moments: Spark already saw a receive the Breez card has not read yet.
    const moved = totalsOf({ spark: sparkReady({ read: true, balance: 5_000 }), lightning: breez(4_000, "same wallet") }, "testnet");
    expect(moved.bitcoin, "the wallet holds 5,000, counted once").toMatchObject({ total: 5_000, ready: 5_000, uncounted: 0 });
    expect(rows(moved.bitcoin)).toEqual(["lightning:testnet: shared 4000", "spark:testnet: counted 5000"]);
    expect(moved.bitcoin?.rows[0]).toMatchObject({ sharedWith: "Spark" });
    const same = totalsOf({ spark: sparkReady({ read: true, balance: 4_000 }), lightning: breez(4_000, "same wallet") }, "testnet");
    expect(rows(same.bitcoin)).toEqual(["lightning:testnet: shared 4000", "spark:testnet: counted 4000"]);
    expect(same.bitcoin).toMatchObject({ total: 4_000 });
    // Spark's balance not read yet: the Breez card is the one reading of that wallet, counted on its own row.
    const unread = totalsOf({ spark: sparkReady({ balance: 0 }), lightning: breez(4_000, "same wallet") }, "testnet");
    expect(rows(unread.bitcoin)).toEqual(["lightning:testnet: counted 4000", "spark:testnet: unknown"]);
  });

  it("counts a Breez Lightning card on another phrase with Spark, even when both hold the same amount: two wallets", () => {
    const equal = totalsOf({ spark: sparkReady({ read: true, balance: 4_000 }), lightning: breez(4_000) }, "testnet");
    expect(equal.bitcoin, "they hold 8,000").toMatchObject({ total: 8_000, ready: 8_000, uncounted: 0 });
    expect(rows(equal.bitcoin)).toEqual(["lightning:testnet: counted 4000", "spark:testnet: counted 4000"]);
    const other = totalsOf({ spark: sparkReady({ read: true, balance: 4_000 }), lightning: breez(900) }, "testnet");
    expect(other.bitcoin).toMatchObject({ total: 4_900 });
  });

  it("among several Breez cards, only the one the engine names as the Spark wallet uses Spark's balance on the deck", () => {
    const card = (id: string, name: string, balance: number, same?: "same wallet") => ({ ...breez(balance, same), card: id, name, receive: id === "spark-seed" });
    const cards = [card("spark-seed", "Breez", 4_000, "same wallet"), card("ln-0ther000", "Breez 2", 5_000)];
    const empty = { mints: [], balance: 0, history: [], feesPaid: 0 };
    const state = walletView({ networks: { mainnet: empty, testnet: { ...empty, spark: sparkReady({ read: true, balance: 5_000 }), lightning: cards[0], lightnings: cards } } }) as WalletState;
    const deck = walletCards(state);
    const totals = walletTotals(state, "testnet", deck);
    expect(totals.bitcoin, "Spark's 5,000 once, plus the other phrase's 5,000").toMatchObject({ total: 10_000, uncounted: 0 });
    expect(totals.bitcoin?.rows.map((r) => `${r.name}: ${r.state}`)).toEqual(["Breez: shared", "Breez 2: counted", "Spark: counted"]);
    expect([...sharedSources(state, "testnet", deck).values()]).toEqual(["Spark"]);
  });

  it("counts a Lightning card through a joined federation once: its balance is the Fedimint card's ecash", () => {
    const fed = federation({ balance: 5_000, modules: ["ln"] });
    const totals = totalsOf({
      lightning: lightningSource({ mode: "testnet", network: "regtest", providerId: "fedimint", label: "Fedimint", read: true, balance: 5_000 }),
      fedimint: { federations: [fed, federation({ id: "cd".repeat(32), balance: 300 })], balance: 5_300, history: [] } as unknown as WalletView["fedimint"],
    }, "testnet");
    expect(rows(totals.bitcoin)).toEqual(["lightning:testnet: shared 5000", "fedimint:testnet: counted 5300"]);
    expect(totals.bitcoin).toMatchObject({ total: 5_300, ready: 5_300, uncounted: 0 });
    expect(totals.bitcoin?.rows[0]).toMatchObject({ sharedWith: "Fedimint" });
    expect(totals.bitcoin?.rows[0].note).toBeUndefined();
    const state = walletView({ lightning: lightningSource({ mode: "testnet", network: "regtest", providerId: "fedimint", label: "Fedimint", read: true, balance: 5_000 }),
      fedimint: { federations: [fed], balance: 5_000, history: [] } as unknown as WalletView["fedimint"] }) as WalletState;
    const t = ((key: string, vars?: Record<string, string>) => `${key} ${vars?.name ?? ""}`) as Translate;
    expect(sharedBalanceCards(state, "testnet", walletCards(state), t).find((c) => c.id === "lightning:testnet")?.balance).toBe("wallet.cards.balance.shared Fedimint");
  });

  it("never sums Testnet and Mainnet: each network's total is its own cards'; USDT is its own total, in its base units", () => {
    const wallet: Partial<WalletView> = {
      mints: [mint(REAL_MINT, 1_000), mint(TEST_MINT, 800)], balance: 1_800,
      ark: arkReady({ read: true }), usdt: usdtReady({ read: true, balance: "12345678" }),
    };
    const mainnet = totalsOf(wallet, "mainnet"), testnet = totalsOf(wallet, "testnet");
    expect(mainnet.bitcoin).toMatchObject({ network: "mainnet", total: 1_000 });
    expect(rows(mainnet.bitcoin)).toEqual(["cashu:mainnet: counted 1000", "lightning:mainnet: shared 1000"]);
    expect(mainnet.usdt).toBeUndefined();
    expect(testnet.bitcoin).toMatchObject({ network: "testnet", total: 800 + 5_000 });
    expect(testnet.usdt).toMatchObject({ network: "testnet", total: 12_345_678n, decimals: 6, test: true, uncounted: 0 });
    // Real USDT on Ethereum is not a test token.
    expect(totalsOf({ usdt: usdtReady({ read: true, chainId: 1, network: "ethereum" }) }, "mainnet").usdt).toMatchObject({ total: 5_000_000n, test: false });
  });

  it("has no total for a currency the network has no card of", () => {
    expect(totalsOf({ usdt: usdtReady({ read: true }) }, "testnet")).toEqual({ usdt: expect.objectContaining({ total: 5_000_000n }) });
    expect(totalsOf({}, "mainnet")).toEqual({});
  });
});

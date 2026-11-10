import { describe, expect, it } from "vitest";
import type { WalletView } from "@ghostly/browser/shared/types";
import { walletCards } from "../../components/walletCardData";
import { walletTotals } from "../../components/walletTotals";
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

  it("counts a Breez Lightning card on the Spark wallet's own phrase once: the same balance is the same wallet", () => {
    const breez = (balance: number) => lightningSource({ mode: "testnet", network: "regtest", providerId: "breez", label: "Breez", read: true, balance });
    const same = totalsOf({ spark: sparkReady({ read: true, balance: 4_000 }), lightning: breez(4_000) }, "testnet");
    expect(rows(same.bitcoin)).toEqual(["lightning:testnet: shared 4000", "spark:testnet: counted 4000"]);
    expect(same.bitcoin).toMatchObject({ total: 4_000 });
    // Another phrase holds another balance: both count.
    const other = totalsOf({ spark: sparkReady({ read: true, balance: 4_000 }), lightning: breez(900) }, "testnet");
    expect(other.bitcoin).toMatchObject({ total: 4_900 });
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

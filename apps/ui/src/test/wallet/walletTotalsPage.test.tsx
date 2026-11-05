import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { WalletView } from "@ghostly/browser/shared/types";
import { Wallet } from "../../pages/Wallet";
import { walletView } from "../fakeEngine";
import { renderApp } from "../render";
import { arkReady, bitcoinSource, mint, REAL_MINT, sparkReady, TEST_MINT, usdtReady } from "../payments/fixtures";

// covers: wallet.balance.total

/**
 * The Wallets page's totals over each tab's deck: Bitcoin (every Bitcoin card of the tab) and USDT, each a button that
 * opens where it comes from, one row per card with an honest note. The tab chooses the network summed.
 */

beforeEach(() => { document.documentElement.dataset.reduceMotion = "true"; });

/** Mainnet: Cashu (and Lightning through its mints). Testnet: Ark, Spark (unread), on-chain with unconfirmed sats, USDT. */
const wallet = (patch: Partial<WalletView> = {}) => walletView({
  mints: [mint(REAL_MINT, 1_000), mint(TEST_MINT, 0)], balance: 1_000,
  ark: arkReady({ read: true, balance: 5_000 }),
  spark: sparkReady(),
  bitcoin: bitcoinSource({ mode: "testnet", network: "regtest", read: true, balance: 170_000, unconfirmed: 40_000 }),
  usdt: usdtReady({ read: true, balance: "12500000" }),
  ...patch,
});

async function openOn(network: "mainnet" | "testnet", patch?: Partial<WalletView>) {
  const view = renderApp(<Wallet />);
  view.engine.update({ wallet: wallet(patch) });
  const tab = await screen.findByTestId(`wallet-network-${network}`);
  if (tab.getAttribute("aria-selected") !== "true") await view.user.click(tab);
  return view;
}

const row = (id: string) => screen.getByTestId(`wallet-total-row-${id}`);

describe("the totals over the deck", () => {
  it("shows the tab's Bitcoin total and its USDT, and says how many cards are not in it", async () => {
    await openOn("testnet");
    const totals = screen.getByTestId("wallet-totals");
    expect(totals).toHaveAttribute("data-network", "testnet");
    expect(totals).toHaveAccessibleName("Balances");
    // 0 (Cashu) + 5,000 (Ark) + 210,000 (on-chain, 40,000 of it unconfirmed); Spark not read yet.
    expect(screen.getByTestId("wallet-total-bitcoin-amount")).toHaveTextContent("215,000test sats");
    expect(screen.getByTestId("wallet-total-bitcoin-uncounted")).toHaveTextContent("1 card not counted");
    expect(screen.getByTestId("wallet-total-usdt-amount")).toHaveTextContent("12.5TEST-USDT");
    expect(screen.queryByTestId("wallet-total-usdt-uncounted")).not.toBeInTheDocument();
    // Above the deck, the cards as they were.
    expect(totals.compareDocumentPosition(screen.getByRole("tablist", { name: "Testnet wallets" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("follows the network tab: Mainnet's total is Mainnet's cards only, and it has no USDT", async () => {
    const { user } = await openOn("testnet");
    await user.click(screen.getByTestId("wallet-network-mainnet"));
    expect(screen.getByTestId("wallet-totals")).toHaveAttribute("data-network", "mainnet");
    expect(screen.getByTestId("wallet-total-bitcoin-amount")).toHaveTextContent("1,000sats");
    expect(screen.queryByTestId("wallet-total-bitcoin-uncounted")).not.toBeInTheDocument();
    expect(screen.queryByTestId("wallet-total-usdt")).not.toBeInTheDocument();
  });

  it("opens where the Bitcoin total comes from: a row per card, its note, what is ready now; Escape closes it back to the total", async () => {
    const { user } = await openOn("testnet");
    const total = screen.getByTestId("wallet-total-bitcoin");
    expect(total).toHaveAttribute("aria-expanded", "false");
    await user.click(total);
    const breakdown = screen.getByRole("dialog", { name: /Bitcoin/ });
    expect(breakdown).toHaveAttribute("data-network", "testnet");
    expect(total).toHaveAttribute("aria-expanded", "true");
    expect(within(breakdown).getByTestId("wallet-total-network")).toHaveTextContent("Test money");
    expect(within(breakdown).getByTestId("wallet-total-sum-amount")).toHaveTextContent("215,000 test sats");
    expect(within(breakdown).getByTestId("wallet-total-ready-amount")).toHaveTextContent("175,000 test sats");
    // The deck's cards, in its order.
    expect(within(screen.getByTestId("wallet-total-rows")).getAllByTestId(/^wallet-total-row-/).map((r) => r.dataset.testid))
      .toEqual(["wallet-total-row-cashu-testnet", "wallet-total-row-lightning-testnet", "wallet-total-row-arkade-testnet", "wallet-total-row-spark-testnet", "wallet-total-row-bitcoin-testnet"]);
    expect(row("cashu-testnet")).toHaveTextContent("Ecash held by your mints");
    expect(row("lightning-testnet")).toHaveAttribute("data-state", "shared");
    expect(row("lightning-testnet")).toHaveTextContent("Same balance as Cashu, counted once");
    expect(row("bitcoin-testnet")).toHaveTextContent("40,000 test sats unconfirmed");
    expect(within(row("bitcoin-testnet")).getByTestId("wallet-total-line-amount")).toHaveTextContent("210,000 test sats");
    // Unknown is never a 0.
    expect(row("spark-testnet")).toHaveAttribute("data-state", "unknown");
    expect(row("spark-testnet")).toHaveTextContent("Couldn't read it now, not in the total");
    expect(within(row("spark-testnet")).getByTestId("wallet-total-line-amount")).toHaveTextContent("?");
    // The longer story behind the ⓘ.
    await user.click(within(screen.getByTestId("wallet-total-sum")).getByTestId("row-info"));
    expect(screen.getByTestId("row-info-text")).toHaveTextContent("Testnet is never added to Mainnet");

    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("wallet-total-breakdown")).not.toBeInTheDocument();
    expect(total).toHaveFocus();
  });

  it("shows a shared balance's number on one card only: Lightning through the mints says it uses Cashu's", async () => {
    const { user } = await openOn("mainnet");
    expect(screen.getByTestId("wallet-card-cashu-mainnet")).toHaveTextContent("1,000 sats");
    const lightning = screen.getByTestId("wallet-card-lightning-mainnet");
    expect(lightning).toHaveTextContent("Uses your Cashu balance");
    expect(lightning).not.toHaveTextContent("1,000");
    expect(lightning).not.toHaveTextContent(/\bsats\b/);
    // The total and where it comes from are as they were: counted once, the row still says so with its amount.
    expect(screen.getByTestId("wallet-total-bitcoin-amount")).toHaveTextContent("1,000sats");
    await user.click(screen.getByTestId("wallet-total-bitcoin"));
    expect(row("lightning-mainnet")).toHaveTextContent("Same balance as Cashu, counted once");
    expect(within(row("lightning-mainnet")).getByTestId("wallet-total-line-amount")).toHaveTextContent("1,000 sats");
  });

  it("opens USDT's own breakdown, with no ready line, and closes from its button", async () => {
    const { user } = await openOn("testnet");
    await user.click(screen.getByTestId("wallet-total-usdt"));
    const breakdown = screen.getByTestId("wallet-total-breakdown");
    expect(breakdown).toHaveAttribute("data-currency", "usdt");
    expect(within(breakdown).getByTestId("wallet-total-sum-amount")).toHaveTextContent("12.5 TEST-USDT");
    expect(within(breakdown).queryByTestId("wallet-total-ready")).not.toBeInTheDocument();
    expect(within(breakdown).getAllByTestId(/^wallet-total-row-/).map((r) => r.dataset.testid)).toEqual(["wallet-total-row-usdt-testnet"]);
    await user.click(within(breakdown).getByTestId("wallet-total-close"));
    expect(screen.queryByTestId("wallet-total-breakdown")).not.toBeInTheDocument();
  });

  it("speaks the app's language: Portuguese words and number formats", async () => {
    const view = renderApp(<Wallet />, { language: "pt" });
    view.engine.update({ wallet: wallet() });
    await view.user.click(await screen.findByTestId("wallet-network-testnet"));
    expect(screen.getByTestId("wallet-total-bitcoin-amount")).toHaveTextContent("215.000");
    expect(screen.getByTestId("wallet-total-bitcoin-uncounted")).toHaveTextContent("1 cartão fora do total");
    await view.user.click(screen.getByTestId("wallet-total-bitcoin"));
    expect(screen.getByTestId("wallet-total-ready")).toHaveTextContent("Pronto para gastar agora");
  });
});

import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_MINTS } from "@ghostly/browser/shared/mints";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { networkState } from "../../components/walletCardData";
import { servicesPlatform, type WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { lightningSource, mint, REAL_MINT } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: wallet.history, wallet.lightning.card, app.i18n
describe("the wallet's history writes the year of a move from an earlier year", () => {
  /**
   * A move from last December read "Dec 31, 11:30 PM", the same as one from this December. Its year is the device's own
   * calendar year, not UTC's: the dates are local times on both sides of New Year, so a check against the UTC year goes
   * wrong for one of them in a zone east of UTC (Asia/Tokyo) and for the other west of it (America/Los_Angeles). Run this
   * file under both with `TZ=` on the vitest command.
   */
  const TEST_MINT = TEST_MINTS[0];
  const LAST_YEAR = new Date(2026, 11, 31, 23, 30).getTime();
  const THIS_YEAR = new Date(2027, 0, 1, 0, 30).getTime();
  const YEAR = /\b20\d\d\b/;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2027, 0, 1, 10, 0));
  });
  afterEach(() => vi.useRealTimers());

  const history = [
    { id: "tx-new", kind: "ecash-in" as const, amount: 100, fee: 0, timestamp: THIS_YEAR, mint: TEST_MINT, note: "this year" },
    { id: "tx-old", kind: "ecash-in" as const, amount: 200, fee: 0, timestamp: LAST_YEAR, mint: TEST_MINT, note: "last year" },
  ];
  const rows = () => Object.fromEntries(screen.getAllByTestId("wallet-tx").map((row) => [within(row).getByText(/year$/).textContent, row]));

  it("a token move: Dec 31 of last year with its year, Jan 1 of this year as before", async () => {
    const state = networkState(walletView({ mints: [mint(TEST_MINT, 300)], balance: 300, history }) as WalletState, "testnet");
    const { user } = renderApp(<CashuWallet wallet={servicesPlatform!.wallet} state={state} rail="cashu" onOpenCashu={() => {}} />);
    await user.click(screen.getByRole("tab", { name: "History" }));
    const { "last year": old, "this year": recent } = rows();
    expect(old).toHaveTextContent("Dec 31, 2026, 11:30 PM");
    expect(recent).toHaveTextContent("Jan 1, 12:30 AM");
    expect(recent).not.toHaveTextContent(YEAR);
  });

  it("in Portuguese, the year as Intl writes it", async () => {
    const state = networkState(walletView({ mints: [mint(TEST_MINT, 300)], balance: 300, history }) as WalletState, "testnet");
    const { user } = renderApp(<CashuWallet wallet={servicesPlatform!.wallet} state={state} rail="cashu" onOpenCashu={() => {}} />, { language: "pt" });
    await user.click(screen.getByRole("tab", { name: "Histórico" }));
    const { "last year": old, "this year": recent } = rows();
    expect(old).toHaveTextContent("31 de dez. de 2026, 23:30");
    expect(recent).toHaveTextContent("1 de jan., 00:30");
    expect(recent).not.toHaveTextContent(YEAR);
  });

  it("a Lightning card's recent payments", () => {
    const op = { direction: "in", providerId: "cln-1", mode: "mainnet", invoice: "lnbc1", amount: 70, expiresAt: 0, state: "paid" } as const;
    const ln = lightningSource({ recent: [{ ...op, paymentHash: "new", createdAt: THIS_YEAR }, { ...op, paymentHash: "old", createdAt: LAST_YEAR }] } as never);
    const state = networkState(walletView({ mints: [mint(REAL_MINT, 0)], lightning: ln }) as WalletState, "mainnet");
    renderApp(<CashuWallet wallet={servicesPlatform!.wallet} state={state} rail="lightning" onOpenCashu={() => {}} />);
    const [recent, old] = screen.getAllByTestId("lightning-op");
    expect(old).toHaveTextContent("Dec 31, 2026, 11:30 PM");
    expect(recent).toHaveTextContent("Jan 1, 12:30 AM");
    expect(recent).not.toHaveTextContent(YEAR);
  });
});

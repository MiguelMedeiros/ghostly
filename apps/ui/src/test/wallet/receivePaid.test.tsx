import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DEFAULT_MINTS, TEST_MINTS } from "@ghostly/browser/shared/mints";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { networkState } from "../../components/walletCardData";
import { servicesPlatform, type WalletPlatform, type WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { REGTEST_INVOICE, mint } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: wallet.cashu.receive-lightning

/**
 * Receive's invoice reads "received" once this invoice is paid: its own mint quote in the history. Other money of the
 * same amount coming in meanwhile (a contact's ecash, our token taken back, a chat request paid) leaves it on screen.
 */
describe("Receive's invoice reads paid only when it is paid", () => {
  const wallet: WalletPlatform = Object.assign(Object.create(servicesPlatform!.wallet), {
    receiveLightning: async () => ({ quote: "our-quote", invoice: REGTEST_INVOICE, expiresAt: null, source: "cashu-mint" }),
  });
  type Tx = WalletState["history"][number];
  const at = (network: "mainnet" | "testnet", url: string, balance: number, history: Tx[]) =>
    networkState(walletView({ mints: [mint(url, balance)], balance, history, mode: network }) as WalletState, network);
  const card = (state: WalletState) => <CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />;

  async function showInvoice(state: WalletState) {
    const view = renderApp(card(state));
    await view.user.click(screen.getByTestId("wallet-receive-amount"));
    await view.user.keyboard("1000{Enter}");
    await waitFor(() => expect(screen.getByTestId("wallet-invoice")).toBeInTheDocument());
    return view;
  }
  const shown = () => ({ said: screen.queryByTestId("wallet-paid")?.textContent ?? null, invoice: !!screen.queryByTestId("wallet-invoice") });

  it("stays on a contact's ecash of the same amount (Mainnet)", async () => {
    const MINT = DEFAULT_MINTS[0];
    const view = await showInvoice(at("mainnet", MINT, 5_000, []));
    const ecash: Tx = { id: "tx-ecash", timestamp: Date.now() + 1, mint: MINT, kind: "ecash-in", amount: 1_000, fee: 0, note: "for the pizza" };
    view.rerender(card(at("mainnet", MINT, 6_000, [ecash])));
    expect(shown()).toEqual({ said: null, invoice: true });
  });

  it("stays on our own ecash taken back (Mainnet: only the balance grows)", async () => {
    const MINT = DEFAULT_MINTS[0];
    const view = await showInvoice(at("mainnet", MINT, 4_000, []));
    view.rerender(card(at("mainnet", MINT, 5_000, [])));
    expect(shown()).toEqual({ said: null, invoice: true });
  });

  it("stays on a chat request of the same amount paid over Lightning (Testnet)", async () => {
    const MINT = TEST_MINTS[0];
    const view = await showInvoice(at("testnet", MINT, 5_000, []));
    const request: Tx = { id: "tx-req", timestamp: Date.now() + 1, mint: MINT, kind: "lightning-in", amount: 1_000, fee: 0, note: "Request paid over Lightning", quote: "a-request-quote" };
    view.rerender(card(at("testnet", MINT, 6_000, [request])));
    expect(shown()).toEqual({ said: null, invoice: true });
  });

  for (const network of ["mainnet", "testnet"] as const) {
    it(`says received once its own quote is minted (${network})`, async () => {
      const MINT = network === "mainnet" ? DEFAULT_MINTS[0] : TEST_MINTS[0];
      const view = await showInvoice(at(network, MINT, 5_000, []));
      const paid: Tx = { id: "tx-ours", timestamp: Date.now() + 1, mint: MINT, kind: "lightning-in", amount: 998, fee: 2, quote: "our-quote" };
      view.rerender(card(at(network, MINT, 5_998, [paid])));
      expect(shown()).toEqual({ said: expect.stringMatching(/1,000 (test )?sats received/), invoice: false });
    });
  }
});

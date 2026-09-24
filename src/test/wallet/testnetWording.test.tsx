import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TEST_MINTS } from "@ghostly/browser/shared/mints";
import { AccountBar } from "../../components/AccountBar";
import { ArkWalletPanel } from "../../components/ArkWalletPanel";
import { BarkWalletPanel } from "../../components/BarkWalletPanel";
import { BitcoinWalletPanel } from "../../components/BitcoinWalletPanel";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { servicesPlatform, type WalletState } from "../../lib/platform";
import { fakeEngine, walletView } from "../fakeEngine";
import { arkReady, barkReady, bitcoinSource, mint, REAL_MINT } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: wallet.mode, wallet.cashu.test-sats

/**
 * In Testnet the wallet page wears a TESTNET badge and a banner: its panels count plain "sats" and do not
 * say "test" again. In Mainnet a test mint's sats, or a wallet on a test network, still say what they are.
 */
describe("the wallet panels' unit", () => {
  const wallet = servicesPlatform!.wallet;
  const TEST_MINT = TEST_MINTS[0];

  it("Cashu in Testnet: the balance is plain sats, with no worthless line under it", () => {
    const state = walletView({ mode: "testnet", mints: [mint(TEST_MINT, 21)], balance: 21 }) as WalletState;
    renderApp(<CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />);
    expect(screen.getByTestId("wallet-balance")).toHaveTextContent(/^21\s*sats$/);
    expect(screen.queryByTestId("wallet-test-balance")).not.toBeInTheDocument();
  });

  it("Cashu in Mainnet: real sats count, and a test mint's sats are set apart as test sats", () => {
    const state = walletView({ mints: [mint(REAL_MINT, 1_300), mint(TEST_MINT, 200)], balance: 1_500 }) as WalletState;
    renderApp(<CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />);
    expect(screen.getByTestId("wallet-balance")).toHaveTextContent(/^1,300\s*sats/);
    expect(screen.getByTestId("wallet-test-balance")).toHaveTextContent("200 test sats (worthless)");
  });

  it("Ark, Bark and Bitcoin in Testnet: sats", () => {
    const state = walletView({ mode: "testnet", ark: arkReady({ network: "mutinynet", balance: 5_000 }), bark: barkReady({ network: "regtest", balance: 3_000 }), bitcoin: { ...bitcoinSource({ balance: 7 }), history: [] } }) as WalletState;
    renderApp(<><ArkWalletPanel wallet={wallet} state={state} /><BarkWalletPanel wallet={wallet} state={state} /><BitcoinWalletPanel wallet={wallet} state={state} /></>);
    expect(screen.getByTestId("ark-balance")).toHaveTextContent(/^5,000\s*sats/);
    expect(screen.getByTestId("bark-balance")).toHaveTextContent(/^3,000\s*sats/);
    expect(screen.getByTestId("bitcoin-balance")).toHaveTextContent(/^7\s*sats/);
    expect(document.body.textContent).not.toContain("test sats");
  });

  it("Ark and Bark on a test network in Mainnet: test sats", () => {
    const state = walletView({ ark: arkReady({ network: "mutinynet", balance: 5_000 }), bark: barkReady({ network: "signet", balance: 3_000 }) }) as WalletState;
    renderApp(<><ArkWalletPanel wallet={wallet} state={state} /><BarkWalletPanel wallet={wallet} state={state} /></>);
    expect(screen.getByTestId("ark-balance")).toHaveTextContent(/^5,000\s*test sats/);
    expect(screen.getByTestId("bark-balance")).toHaveTextContent(/^3,000\s*test sats/);
  });
});

describe("the account bar's Wallets place", () => {
  const TEST_MINT = TEST_MINTS[0];

  it("says Wallets and nothing about the balance, in Testnet", () => {
    act(() => fakeEngine.update({ wallet: walletView({ mode: "testnet", mints: [mint(TEST_MINT, 109_079)], balance: 109_079 }) }));
    renderApp(<AccountBar />);
    expect(screen.getByTestId("wallet-chip")).toHaveTextContent(/^Wallets$/);
    expect(screen.getByTestId("wallet-chip")).toHaveAccessibleName("Wallets");
    expect(screen.getByTestId("wallet-chip").textContent).not.toMatch(/sats|109/);
  });

  it("and in Mainnet, whatever is held at a test mint", () => {
    act(() => fakeEngine.update({ wallet: walletView({ mints: [mint(REAL_MINT, 1_300), mint(TEST_MINT, 200)], balance: 1_500 }) }));
    renderApp(<AccountBar />);
    expect(screen.getByTestId("wallet-chip")).toHaveTextContent(/^Wallets$/);
    expect(screen.getByTestId("wallet-chip")).toHaveAccessibleName("Wallets");
  });

  it("in Portuguese: Carteiras", () => {
    act(() => fakeEngine.update({ wallet: walletView() }));
    renderApp(<AccountBar />, { language: "pt" });
    expect(screen.getByTestId("wallet-chip")).toHaveTextContent(/^Carteiras$/);
  });
});

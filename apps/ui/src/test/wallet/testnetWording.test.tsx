import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TEST_MINTS } from "@ghostly/browser/shared/mints";
import { AccountBar } from "../../components/AccountBar";
import { ArkWalletPanel } from "../../components/ArkWalletPanel";
import { BarkWalletPanel } from "../../components/BarkWalletPanel";
import { BitcoinWalletPanel } from "../../components/BitcoinWalletPanel";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { networkState } from "../../components/walletCardData";
import { servicesPlatform, type WalletNetwork, type WalletState } from "../../lib/platform";
import { fakeEngine, walletView } from "../fakeEngine";
import { arkReady, barkReady, bitcoinSource, mint, REAL_MINT } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: wallet.mode, wallet.cashu.test-sats, wallet.instances.networks

/**
 * There is no Testnet mode, badge or banner any more: each wallet is on one network, and a Testnet wallet's panel
 * says its amounts are test sats wherever they show. A Mainnet wallet counts plain sats.
 */
describe("the wallet panels' unit", () => {
  const wallet = servicesPlatform!.wallet;
  const TEST_MINT = TEST_MINTS[0];
  /** One network's wallets, as the wallet page hands them to a panel. */
  const onNetwork = (network: WalletNetwork, patch: Partial<WalletState>) => networkState(walletView(patch) as WalletState, network);

  it("Cashu on a Testnet wallet: the balance says test sats, with no worthless line under it", () => {
    const state = onNetwork("testnet", { mints: [mint(TEST_MINT, 21)], balance: 21 });
    renderApp(<CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />);
    expect(screen.getByTestId("wallet-balance")).toHaveTextContent(/^21\s*test sats$/);
    expect(screen.queryByTestId("wallet-test-balance")).not.toBeInTheDocument();
  });

  it("Cashu on a Mainnet wallet: plain sats", () => {
    const state = onNetwork("mainnet", { mints: [mint(REAL_MINT, 1_300)], balance: 1_300 });
    renderApp(<CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />);
    expect(screen.getByTestId("wallet-balance")).toHaveTextContent(/^1,300\s*sats$/);
    expect(screen.queryByTestId("wallet-test-balance")).not.toBeInTheDocument();
  });

  it("Cashu on a Mainnet wallet that still lists a test mint: its sats are set apart as test sats, never counted", () => {
    const state = walletView({ mints: [mint(REAL_MINT, 1_300), mint(TEST_MINT, 200)], balance: 1_500 }) as WalletState;
    renderApp(<CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />);
    expect(screen.getByTestId("wallet-balance")).toHaveTextContent(/^1,300\s*sats/);
    expect(screen.getByTestId("wallet-test-balance")).toHaveTextContent("200 test sats (worthless)");
  });

  it("Cashu never offers to switch to Testnet, even with test sats waiting there", () => {
    const state = onNetwork("mainnet", { mints: [mint(REAL_MINT, 1_300), mint(TEST_MINT, 500)], balance: 1_800 });
    renderApp(<CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />);
    expect(screen.queryByTestId("wallet-waiting-test-sats")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Switch to Testnet" })).not.toBeInTheDocument();
  });

  it("Ark and Bark on a Testnet wallet: test sats", () => {
    const state = onNetwork("testnet", { ark: arkReady({ network: "mutinynet", balance: 5_000 }), bark: barkReady({ network: "regtest", balance: 3_000 }) });
    renderApp(<><ArkWalletPanel wallet={wallet} state={state} /><BarkWalletPanel wallet={wallet} state={state} /></>);
    expect(screen.getByTestId("ark-balance")).toHaveTextContent(/^5,000\s*test sats/);
    expect(screen.getByTestId("bark-balance")).toHaveTextContent(/^3,000\s*test sats/);
  });

  it("Bitcoin on a Testnet wallet: test sats", () => {
    const state = onNetwork("testnet", { bitcoin: bitcoinSource({ mode: "testnet", balance: 7 }) });
    renderApp(<BitcoinWalletPanel wallet={wallet} state={state} />);
    expect(screen.getByTestId("bitcoin-balance")).toHaveTextContent(/^7\s*test sats/);
  });

  it("Ark, Bark and Bitcoin on a Mainnet wallet: plain sats, and nothing says test", () => {
    const state = onNetwork("mainnet", { ark: arkReady({ network: "bitcoin", balance: 5_000 }), bark: barkReady({ network: "bitcoin", balance: 3_000 }), bitcoin: bitcoinSource({ balance: 7 }) });
    renderApp(<><ArkWalletPanel wallet={wallet} state={state} /><BarkWalletPanel wallet={wallet} state={state} /><BitcoinWalletPanel wallet={wallet} state={state} /></>);
    expect(screen.getByTestId("ark-balance")).toHaveTextContent(/^5,000\s*sats/);
    expect(screen.getByTestId("bark-balance")).toHaveTextContent(/^3,000\s*sats/);
    expect(screen.getByTestId("bitcoin-balance")).toHaveTextContent(/^7\s*sats/);
    expect(document.body.textContent).not.toContain("test sats");
  });
});

describe("the account bar's Wallets place", () => {
  const TEST_MINT = TEST_MINTS[0];

  it("says Wallets and nothing about the balance, with a Testnet wallet", () => {
    act(() => fakeEngine.update({ wallet: walletView({ mode: "testnet", mints: [mint(TEST_MINT, 109_079)], balance: 109_079 }) }));
    renderApp(<AccountBar />);
    expect(screen.getByTestId("wallet-chip")).toHaveTextContent(/^Wallets$/);
    expect(screen.getByTestId("wallet-chip")).toHaveAccessibleName("Wallets");
    expect(screen.getByTestId("wallet-chip").textContent).not.toMatch(/sats|109/);
  });

  it("and with a Mainnet wallet, whatever is held at a test mint", () => {
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

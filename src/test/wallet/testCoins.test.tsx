import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SEPOLIA_TEST_USDT } from "@ghostly/core";
import type { WalletView } from "@ghostly/browser/shared/types";
import { Wallet } from "../../pages/Wallet";
import { faucetFor } from "../../components/wallet/TestCoins";
import { networkState } from "../../components/walletCardData";
import { walletView } from "../fakeEngine";
import { renderApp } from "../render";
import { arkReady, barkReady, bitcoinSource, lightningSource, mint, REAL_MINT, sparkReady, TEST_MINT, usdtReady } from "../payments/fixtures";

// covers: wallet.test-coins

/** Opens the Wallets page on one card, on its network's tab. */
async function open(wallet: WalletView, card: string) {
  const app = renderApp(<Wallet />);
  app.engine.update({ wallet });
  await app.user.click(await screen.findByTestId(`wallet-network-${card.split("-")[1]}`));
  await app.user.click(await screen.findByTestId(`wallet-card-${card}`));
  return app;
}

describe("Get test coins", () => {
  it("is on a Testnet wallet's details, labelled test money, and not on a Mainnet one", async () => {
    const { user } = await open(walletView({ mints: [mint(TEST_MINT, 0), mint(REAL_MINT, 0)] }), "cashu-testnet");
    const section = await screen.findByTestId("test-coins");
    expect(within(section).getByTestId("test-coins-network")).toHaveTextContent("Test money");
    expect(section).toHaveTextContent("10,000 test sats from the test mint, only when you press the button");
    expect(within(section).getByTestId("test-coins-get")).toHaveTextContent("Get test coins");
    await user.click(screen.getByTestId("wallet-network-mainnet"));
    await waitFor(() => expect(screen.getByTestId("wallet-panel")).toHaveAttribute("data-network", "mainnet"));
    await waitFor(() => expect(screen.queryByTestId("test-coins")).not.toBeInTheDocument());
    expect(screen.queryByTestId("test-coins-get")).not.toBeInTheDocument();
  });

  it("says it is asking, then what came in", async () => {
    const { user, engine } = await open(walletView({ mints: [mint(TEST_MINT, 0)] }), "cashu-testnet");
    let pay!: () => void;
    engine.on("walletTestCoins", () => new Promise((resolve) => { pay = () => resolve({ amount: 10_000, unit: "test sats" }); }));
    const get = await screen.findByTestId("test-coins-get");
    await user.click(get);
    expect(get).toHaveTextContent("Asking the faucet…");
    expect(get).toBeDisabled();
    pay();
    expect(await screen.findByTestId("test-coins-result")).toHaveTextContent("+10,000 test sats");
    expect(get).toHaveTextContent("Get test coins");
    expect(engine.callsTo("walletTestCoins")).toEqual([{ type: "cashu", network: "testnet" }]);
  });

  it("an error says why, and Retry asks again", async () => {
    const { user, engine } = await open(walletView({ mints: [mint(TEST_MINT, 0)] }), "lightning-testnet");
    engine.on("walletTestCoins", () => { throw new Error("Rate limited: the faucet is busy. Try again in a minute."); });
    await user.click(await screen.findByTestId("test-coins-get"));
    expect(await screen.findByTestId("test-coins-error")).toHaveTextContent("Rate limited: the faucet is busy. Try again in a minute.");
    engine.on("walletTestCoins", () => ({ amount: 10_000, unit: "test sats" }));
    await user.click(screen.getByTestId("test-coins-retry"));
    expect(await screen.findByTestId("test-coins-result")).toHaveTextContent("+10,000 test sats");
    expect(screen.queryByTestId("test-coins-error")).not.toBeInTheDocument();
    expect(engine.callsTo("walletTestCoins")).toEqual([{ type: "lightning", network: "testnet" }, { type: "lightning", network: "testnet" }]);
  });

  it("USDT on Sepolia: needs gas first, then 1,000 TEST-USDT on the way", async () => {
    const { user, engine } = await open(walletView({ usdt: usdtReady({ token: SEPOLIA_TEST_USDT, network: "sepolia", gasBalance: "0" }) }), "usdt-testnet");
    expect(await screen.findByTestId("test-coins-get")).toBeDisabled();
    expect(screen.getByTestId("test-coins-needs")).toHaveTextContent("Sepolia ETH for gas");
    engine.update({ wallet: walletView({ usdt: usdtReady({ token: SEPOLIA_TEST_USDT, network: "sepolia", gasBalance: "1000000000000000" }) }) });
    await waitFor(() => expect(screen.getByTestId("test-coins-get")).toBeEnabled());
    engine.on("walletTestCoins", () => ({ amount: 1_000, unit: "TEST-USDT", pending: true }));
    await user.click(screen.getByTestId("test-coins-get"));
    expect(await screen.findByTestId("test-coins-result")).toHaveTextContent("+1,000 TEST-USDT on the way");
  });

  it("a faucet behind a login is a link, never asked by Ghostly", async () => {
    await open(walletView({ ark: arkReady({ network: "mutinynet" }) }), "arkade-testnet");
    const link = await screen.findByTestId("test-coins-open");
    expect(link).toHaveAttribute("href", "https://faucet.mutinynet.com");
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.getByTestId("test-coins")).toHaveTextContent("GitHub login");
    expect(screen.queryByTestId("test-coins-get")).not.toBeInTheDocument();
  });
});

describe("which faucet a Testnet wallet has", () => {
  const on = (patch: Partial<WalletView>) => networkState(walletView(patch), "testnet");
  it("asks only the faucets that need nothing; links the ones behind a login or a CAPTCHA; none on Mainnet or a local chain", () => {
    expect(faucetFor("cashu", "testnet", on({ mints: [mint(TEST_MINT, 0)] }))).toMatchObject({ kind: "ask" });
    expect(faucetFor("cashu", "mainnet", networkState(walletView({ mints: [mint(REAL_MINT, 0)] }), "mainnet"))).toBeNull();
    expect(faucetFor("lightning", "testnet", on({ mints: [mint(TEST_MINT, 0)], lightning: lightningSource({ mode: "testnet", providerId: "breez" }) }))).toMatchObject({ kind: "open", url: "https://app.lightspark.com/regtest-faucet" });
    expect(faucetFor("lightning", "testnet", on({ lightning: lightningSource({ mode: "testnet", providerId: "lnd" }) }))).toBeNull();
    expect(faucetFor("bark", "testnet", on({ bark: barkReady() }))).toMatchObject({ kind: "open", url: "https://signet.2nd.dev" });
    expect(faucetFor("spark", "testnet", on({ spark: sparkReady() }))).toMatchObject({ kind: "open" });
    expect(faucetFor("bitcoin", "testnet", on({ bitcoin: bitcoinSource({ mode: "testnet", network: "signet" }) }))).toMatchObject({ kind: "open", url: "https://signetfaucet.com" });
    expect(faucetFor("bitcoin", "testnet", on({ bitcoin: bitcoinSource({ mode: "testnet", network: "regtest" }) }))).toBeNull();
    expect(faucetFor("arkade", "testnet", on({ ark: arkReady({ network: "regtest" }) }))).toBeNull();
    expect(faucetFor("usdt", "testnet", on({ usdt: usdtReady({ network: "evm-local", chainId: 31337, token: "0x5FbDB2315678afecb367f032d93F642f64180aa3" }) }))).toBeNull();
    expect(faucetFor("fedimint", "testnet", on({}))).toBeNull();
  });
});

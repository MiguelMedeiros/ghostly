import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UsdtWalletPanel } from "../../components/UsdtWalletPanel";
import { networkState } from "../../components/walletCardData";
import type { WalletNetwork, WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { usdtReady } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: wallet.instances.networks, wallet.usdt.send

/*
 * Miguel, 2026-10-12, Wallets with Mainnet chosen and the USDT card in front: "ta mostrando historico da testnet mesmo
 * com mainnet selecionada ?". The profile keeps one list of payments for both networks; a card lists its own network's.
 */

const payment = (id: string, network: "ethereum" | "sepolia", amount: number, state: "settled" | "cancelled") =>
  ({ id, method: "usdt", network, provider: "0xToken", asset: network === "ethereum" ? "USDT" : "TEST-USDT", unit: "token-base", decimals: 6, address: "0xabc", expiresAt: 0,
    payee: "0xabc", amount: amount * 1_000_000, fee: 0, feeCap: 0, createdAt: 1, state }) as unknown as NonNullable<WalletState["intents"]>[number];

const both = walletView({
  networks: {
    mainnet: { mints: [], balance: 0, history: [], feesPaid: 0, usdt: usdtReady({ network: "ethereum", chainId: 1, balance: "0", gasBalance: "0" }) },
    testnet: { mints: [], balance: 0, history: [], feesPaid: 0, usdt: usdtReady() },
  },
  intents: [payment("t1", "sepolia", 1000, "cancelled"), payment("t2", "sepolia", 1000, "settled"), payment("m1", "ethereum", 25, "settled")],
}) as WalletState;
const panel = (network: WalletNetwork) => renderApp(<UsdtWalletPanel wallet={{} as never} state={networkState(both, network)} />);

describe("the USDT card's payments", () => {
  it("on Mainnet lists the real payments only: no test payment reads as real money moved", () => {
    panel("mainnet");
    const wallet = screen.getByTestId("usdt-wallet");
    expect(wallet).toHaveTextContent("25 USDT");
    expect(wallet).not.toHaveTextContent("TEST-USDT");
    expect(wallet).not.toHaveTextContent("1,000");
  });

  it("on Testnet lists the test payments only", () => {
    panel("testnet");
    const wallet = screen.getByTestId("usdt-wallet");
    expect(wallet.textContent!.match(/1,000 TEST-USDT/g)).toHaveLength(2);
    expect(wallet).not.toHaveTextContent("25 USDT");
  });
});

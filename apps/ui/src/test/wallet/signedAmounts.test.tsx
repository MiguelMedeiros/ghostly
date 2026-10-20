import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BitcoinWalletPanel } from "../../components/BitcoinWalletPanel";
import { FedimintWalletPanel } from "../../components/FedimintWalletPanel";
import { SparkWalletPanel } from "../../components/SparkWalletPanel";
import { Wallet } from "../../pages/Wallet";
import { servicesPlatform, type WalletPlatform, type WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { mint, TEST_MINT } from "../payments/fixtures";
import { renderApp } from "../render";
import { offered, sourceView } from "./descriptors";

// covers: wallet.history, app.i18n

/**
 * A movement's sign stays at its number's left in Arabic too: the digits are Latin in every language, and a bare "−"
 * at the start of a right-to-left line goes after them ("1,000−"). Each history writes the signed amount as its own
 * left-to-right run.
 */
const runs = (row: HTMLElement) => [...row.querySelectorAll('[dir="ltr"]')].map((el) => el.textContent);

describe("in Arabic, a wallet history's signed amounts read left to right", () => {
  it("in the Cashu history", async () => {
    const { engine, user } = renderApp(<Wallet />, { language: "ar" });
    engine.update({ wallet: walletView({ mints: [mint(TEST_MINT, 9_000)], balance: 9_000, history: [
      { id: "in", timestamp: 2, mint: TEST_MINT, kind: "lightning-in", amount: 10_000, fee: 0 },
      { id: "out", timestamp: 1, mint: TEST_MINT, kind: "lightning-out", amount: 1_000, fee: 0 },
    ] }) });
    await user.click(await screen.findByTestId("wallet-network-testnet"));
    await user.click(await screen.findByTestId("wallet-history"));
    const rows = await screen.findAllByTestId("wallet-tx");
    expect(rows.map(runs)).toEqual([["+10,000"], ["−1,000"]]);
  });

  it("in the Spark history", () => {
    const history = [{ id: "t1", direction: "in" as const, amount: 1_200, fee: 0, at: 2, status: "completed" as const, via: "spark" as const },
      { id: "t2", direction: "out" as const, amount: 300, fee: 0, at: 1, status: "completed" as const, via: "lightning" as const }];
    const state = walletView({ mode: "testnet", spark: { configured: true, locked: false, network: "regtest", address: "sparkrt1x", balance: 900, history } }) as WalletState;
    renderApp(<SparkWalletPanel wallet={servicesPlatform!.wallet} state={state} />, { language: "ar" });
    expect(screen.getAllByTestId("spark-history-row").map(runs)).toEqual([["+1,200"], ["−300"]]);
  });

  it("in the Fedimint history, its fee beside it", async () => {
    const federation = { id: "a".repeat(64), name: "Alpha", balance: 5_000, status: "ready" as const, lightning: true, invite: "fed1a",
      guardians: [{ id: 0, name: "g0" }], consensusVersion: "2.1", network: "regtest", modules: ["ln", "mint"] };
    const history = [{ id: "t1", federation: federation.id, kind: "lightning-out", amount: 12_000, fee: 1_500, state: "done", createdAt: 2 },
      { id: "t2", federation: federation.id, kind: "notes-in", amount: 300, state: "done", createdAt: 1 }];
    const state = walletView({ mode: "testnet", fedimint: { federations: [federation], balance: 5_000, history } as never }) as WalletState;
    const { user } = renderApp(<FedimintWalletPanel wallet={{} as WalletPlatform} state={state} />, { language: "ar" });
    await user.click(screen.getByTestId("wallet-history"));
    const rows = screen.getAllByTestId("fedimint-tx");
    expect(rows.map(runs)).toEqual([["−12,000"], ["+300"]]);
    expect(rows[0]).toHaveTextContent("1,500");
  });

  it("in the on-chain Bitcoin history, confirmed or not", async () => {
    const bitcoin = { ...sourceView({ mode: "testnet", status: "ready", network: "regtest", offered: offered("onchain", "testnet") }), balance: 49_000, history: [
      { txid: "in".padEnd(64, "0"), amount: 50_000, confirmations: 3 },
      { txid: "out".padEnd(64, "0"), amount: -1_000, confirmations: 0 },
    ] };
    const { user } = renderApp(<BitcoinWalletPanel wallet={servicesPlatform!.wallet} state={walletView({ mode: "testnet", bitcoin }) as WalletState} />, { language: "ar" });
    await user.click(screen.getByTestId("wallet-history"));
    expect(screen.getAllByTestId("bitcoin-tx").map(runs)).toEqual([["+50,000"], ["−1,000"]]);
  });
});

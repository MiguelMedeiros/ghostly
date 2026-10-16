import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TEST_MINTS } from "@ghostly/browser/shared/mints";
import { ArkWalletPanel } from "../../components/ArkWalletPanel";
import { BarkWalletPanel } from "../../components/BarkWalletPanel";
import { BitcoinWalletPanel } from "../../components/BitcoinWalletPanel";
import { FedimintWalletPanel } from "../../components/FedimintWalletPanel";
import { SparkWalletPanel } from "../../components/SparkWalletPanel";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { networkState } from "../../components/walletCardData";
import { servicesPlatform, type WalletNetwork, type WalletPlatform, type WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { arkReady, barkReady, bitcoinSource, lightningSource, mint, sparkReady } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: wallet.mode, app.i18n

/**
 * A wallet's balance in Arabic: the number is its own run, and the unit beside it stays in the line's direction. The
 * Arabic unit starts with the Latin "sats" ("sats تجريبية"), and with only a margin between the two spans, the number
 * and "sats" made one left-to-right run: "100,000sats", glued, the unit on the number's right and its Arabic word
 * split off. As the invoice card does (InvoiceBubble).
 */
const wallet = servicesPlatform!.wallet;
const onNetwork = (network: WalletNetwork, patch: Partial<WalletState>) => networkState(walletView(patch) as WalletState, network);

function isolatedNumber(balance: HTMLElement, number: string, unit: RegExp) {
  const [amount, beside] = [...balance.children] as HTMLElement[];
  expect(amount.tagName).toBe("BDI");
  expect(amount).toHaveTextContent(new RegExp(`^${number}$`));
  expect(beside.tagName).toBe("SPAN");
  expect(beside).not.toHaveAttribute("dir");
  expect(beside).toHaveTextContent(unit);
}

describe("in Arabic, a wallet's balance keeps its number apart from its unit", () => {
  it("Cashu, Testnet and Mainnet", () => {
    const { unmount } = renderApp(<CashuWallet wallet={wallet} state={onNetwork("testnet", { mints: [mint(TEST_MINTS[0], 100_000)], balance: 100_000 })} rail="cashu" onOpenCashu={() => {}} />, { language: "ar" });
    isolatedNumber(screen.getByTestId("wallet-balance"), "100,000", /^sats تجريبية$/);
    unmount();
    renderApp(<CashuWallet wallet={wallet} state={onNetwork("mainnet", { mints: [mint("https://mint.example.com", 1_300)], balance: 1_300 })} rail="cashu" onOpenCashu={() => {}} />, { language: "ar" });
    isolatedNumber(screen.getByTestId("wallet-balance"), "1,300", /^sats$/);
  });

  it("a Lightning card, its source beside the unit", () => {
    const state = onNetwork("testnet", { lightning: lightningSource({ mode: "testnet", balance: 100_000, label: "Fake Lightning" }) });
    renderApp(<CashuWallet wallet={wallet} state={state} rail="lightning" onOpenCashu={() => {}} />, { language: "ar" });
    isolatedNumber(screen.getByTestId("wallet-balance"), "100,000", /^sats تجريبية · Fake Lightning$/);
  });

  it("Spark, Ark, Bark and on-chain", () => {
    const state = onNetwork("testnet", { spark: sparkReady({ balance: 4_000 }), ark: arkReady({ network: "mutinynet", balance: 5_000 }), bark: barkReady({ network: "regtest", balance: 3_000 }), bitcoin: bitcoinSource({ mode: "testnet", balance: 7 }) });
    renderApp(<><SparkWalletPanel wallet={wallet} state={state} /><ArkWalletPanel wallet={wallet} state={state} /><BarkWalletPanel wallet={wallet} state={state} /><BitcoinWalletPanel wallet={wallet} state={state} /></>, { language: "ar" });
    isolatedNumber(screen.getByTestId("spark-balance"), "4,000", /^sats تجريبية$/);
    isolatedNumber(screen.getByTestId("ark-balance"), "5,000", /^sats تجريبية$/);
    isolatedNumber(screen.getByTestId("bark-balance"), "3,000", /^sats تجريبية$/);
    isolatedNumber(screen.getByTestId("bitcoin-balance"), "7", /^sats تجريبية$/);
  });

  it("Fedimint", () => {
    const federation = { id: "a".repeat(64), name: "Alpha", balance: 5_000, status: "ready" as const, lightning: true, invite: "fed1a",
      guardians: [{ id: 0, name: "g0" }], consensusVersion: "2.1", network: "regtest", modules: ["ln", "mint"] };
    const state = walletView({ mode: "testnet", fedimint: { federations: [federation], balance: 5_000, history: [] } as never }) as WalletState;
    renderApp(<FedimintWalletPanel wallet={{} as WalletPlatform} state={state} />, { language: "ar" });
    isolatedNumber(screen.getByTestId("fedimint-balance"), "5,000", /^sats تجريبية$/);
  });
});

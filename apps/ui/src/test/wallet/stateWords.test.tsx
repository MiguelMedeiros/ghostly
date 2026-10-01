import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PaymentReview as Review } from "@ghostly/core";
import { ArkWalletPanel } from "../../components/ArkWalletPanel";
import { PaymentBubble } from "../../components/PaymentBubble";
import { PaymentReview } from "../../components/PaymentReview";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { networkState } from "../../components/walletCardData";
import { servicesPlatform, type WalletNetwork, type WalletState } from "../../lib/platform";
import { fakeEngine, linkView, paymentView, walletView } from "../fakeEngine";
import { arkReady, lightningSource, mint, REAL_MINT, target, TEST_MINT } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: payments.chat.review, wallet.lightning.sources

/**
 * The engine's own words (`pending`, `settled`, `cashu-test`, `arkade · regtest · BTC`) never reach the person: a
 * payment's state and its way of paying read as words, in the app's language.
 */
const wallet = servicesPlatform!.wallet;
const onNetwork = (network: WalletNetwork, patch: Partial<WalletState>) => networkState(walletView(patch) as WalletState, network);
const review = (patch: Partial<Review>): Review => ({
  method: "cashu", network: "cashu-test", provider: TEST_MINT, asset: "BTC", unit: "sat", address: "pay-1", expiresAt: Date.now() + 60_000,
  id: "review-1", payee: "peer", amount: 21, fee: 1, feeCap: 10, createdAt: 0, state: "pending", ...patch,
} as Review);

describe("a payment's way of paying", () => {
  it.each([
    [{ method: "cashu", network: "cashu-test" }, "Cashu"],
    [{ method: "cashu", network: "bitcoin" }, "Cashu"],
    [{ method: "arkade", network: "regtest" }, "Ark · Regtest"],
    [{ method: "bitcoin", network: "signet" }, "Bitcoin on-chain · Signet"],
    [{ method: "usdt", network: "sepolia", asset: "TEST-USDT" }, "USDT · Sepolia"],
  ] as const)("the review of %o says “%s”", (patch, line) => {
    renderApp(<PaymentReview review={review(patch as Partial<Review>)} wallet={wallet} onClose={() => {}} />);
    expect(screen.getByTestId("review-rail")).toHaveTextContent(new RegExp(`^${line}$`));
  });

  it("a Cashu payment in the chat says Cashu, not the engine's network name", () => {
    fakeEngine.setState({ links: [linkView()], wallet: { mints: [mint(TEST_MINT, 0)] }, payments: { "pay-1": paymentView({ kind: "payment", direction: "out", target: target({ method: "cashu", network: "cashu-test", provider: TEST_MINT }) }) } });
    renderApp(<PaymentBubble paymentId="pay-1" peerPubKey="peer" fallbackText="[a payment]" />);
    expect(screen.getByTestId("payment-rail")).toHaveTextContent(/^Cashu$/);
  });
});

describe("a payment's state, in the app's language", () => {
  it("a wallet's list of payments says each state in words (Portuguese)", () => {
    const pending = review({ method: "arkade", network: "mutinynet", provider: "ark", id: "a", state: "pending" });
    const settled = review({ method: "arkade", network: "mutinynet", provider: "ark", id: "b", state: "settled" });
    const state = onNetwork("testnet", { ark: arkReady({ network: "mutinynet" }), intents: [pending, settled] });
    renderApp(<ArkWalletPanel wallet={wallet} state={state} />, { language: "pt" });
    expect(screen.getByRole("button", { name: "21 sats de teste · pendente" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "21 sats de teste · pago" })).toBeInTheDocument();
  });

  it("the Cashu wallet's list of payments says each state in words too (Portuguese)", () => {
    const pending = review({ id: "a", state: "pending" });
    const unknown = review({ id: "b", state: "unknown" });
    const state = onNetwork("testnet", { mints: [mint(TEST_MINT, 0)], intents: [pending, unknown] });
    renderApp(<CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />, { language: "pt" });
    expect(screen.getByRole("button", { name: "21 sats de teste · pendente" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /· (pending|unknown)$/ })).not.toBeInTheDocument();
  });

  it("a Lightning card's recent invoices and payments say their state in words, and test sats on Testnet", () => {
    const ln = lightningSource({ mode: "testnet", recent: [
      { direction: "in", providerId: "cln-1", mode: "testnet", paymentHash: "h1", invoice: "lntb1", amount: 50, expiresAt: 0, createdAt: 0, state: "open" },
      { direction: "out", providerId: "cln-1", mode: "testnet", paymentHash: "h2", invoice: "lntb2", amount: 70, expiresAt: 0, createdAt: 0, state: "paid", fee: 1 },
    ] } as never);
    const state = onNetwork("testnet", { mints: [mint(TEST_MINT, 0)], lightning: ln });
    renderApp(<CashuWallet wallet={wallet} state={state} rail="lightning" onOpenCashu={() => {}} />, { language: "pt" });
    const rows = screen.getAllByTestId("lightning-op");
    expect(rows[0]).toHaveTextContent("50 sats de teste");
    expect(rows[0]).toHaveTextContent("aguardando pagamento");
    expect(rows[1]).toHaveTextContent("pago");
    for (const row of rows) expect(row.textContent).not.toMatch(/\b(open|paid)\b/);
  });

  it("Mainnet keeps plain sats on the Lightning rows", () => {
    const ln = lightningSource({ recent: [{ direction: "in", providerId: "cln-1", mode: "mainnet", paymentHash: "h1", invoice: "lnbc1", amount: 50, expiresAt: 0, createdAt: 0, state: "expired" }] } as never);
    renderApp(<CashuWallet wallet={wallet} state={onNetwork("mainnet", { mints: [mint(REAL_MINT, 0)], lightning: ln })} rail="lightning" onOpenCashu={() => {}} />);
    expect(screen.getByTestId("lightning-op")).toHaveTextContent("Invoice · 50 sats");
    expect(screen.getByTestId("lightning-op")).toHaveTextContent("expired");
  });
});

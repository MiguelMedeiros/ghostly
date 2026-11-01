import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { engineText } from "@ghostly/core";
import { PaymentBubble } from "../../components/PaymentBubble";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { networkState } from "../../components/walletCardData";
import { servicesPlatform, type WalletNetwork, type WalletState } from "../../lib/platform";
import { fakeEngine, linkView, paymentView, walletView } from "../fakeEngine";
import { lightningSource, liveMainnetInvoice, mint, REAL_MINT, TEST_MINT } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: wallet.cashu.mint.add, wallet.lightning.sources

/**
 * The engine writes its errors in English (the CLI prints them as they are). The ones it knows by a code reach the
 * person in the app's language; any other text, a mint's own words, stays as it is.
 */
const wallet = servicesPlatform!.wallet;
const onNetwork = (network: WalletNetwork, patch: Partial<WalletState>) => networkState(walletView(patch) as WalletState, network);

describe("an engine error, in the app's language", () => {
  it("a mint of the other network, refused (#815), says why in Portuguese", async () => {
    const { user, engine } = renderApp(<CashuWallet wallet={wallet.forNetwork("mainnet")} state={onNetwork("mainnet", { mints: [mint(REAL_MINT, 0)] })} rail="cashu" onOpenCashu={() => {}} />, { language: "pt" });
    engine.on("walletAddMint", () => { throw new Error(engineText("testMintOnMainnet")); });
    await user.type(screen.getByTestId("wallet-mint-url"), TEST_MINT);
    await user.click(screen.getByTestId("wallet-add-mint"));
    expect(await screen.findByTestId("wallet-error")).toHaveTextContent("Este é um mint de teste: seus sats não valem nada" + "Adicione-o a uma carteira Cashu Testnet.");
  });

  it("a mint that did not answer names it, in Portuguese; a mint's own words stay as they are", async () => {
    const { user, engine } = renderApp(<CashuWallet wallet={wallet.forNetwork("mainnet")} state={onNetwork("mainnet", { mints: [mint(REAL_MINT, 0)] })} rail="cashu" onOpenCashu={() => {}} />, { language: "pt" });
    engine.on("walletAddMint", () => { throw new Error(engineText("hostTimedOut", { host: "mint.example.org" })); });
    await user.type(screen.getByTestId("wallet-mint-url"), "https://mint.example.org");
    await user.click(screen.getByTestId("wallet-add-mint"));
    expect(await screen.findByTestId("wallet-error")).toHaveTextContent("mint.example.org não respondeu a tempo");
    engine.on("walletAddMint", () => { throw new Error("Keyset not active"); });
    await user.click(screen.getByTestId("wallet-add-mint"));
    expect(await screen.findByText("Keyset not active")).toBeInTheDocument();
  });

  it("a Lightning payment's error in the recent rows, in Portuguese", () => {
    const ln = lightningSource({ recent: [{ direction: "out", providerId: "cln-1", mode: "mainnet", paymentHash: "h", invoice: "lnbc1", amount: 70, expiresAt: 0, createdAt: 0, state: "failed", error: engineText("invoiceExpired") }] } as never);
    renderApp(<CashuWallet wallet={wallet} state={onNetwork("mainnet", { mints: [mint(REAL_MINT, 0)], lightning: ln })} rail="lightning" onOpenCashu={() => {}} />, { language: "pt" });
    expect(screen.getByTestId("lightning-op")).toHaveTextContent("Essa fatura expirou");
  });

  it("a payment's error in the chat, in Portuguese", () => {
    fakeEngine.setState({ links: [linkView()], wallet: { mints: [mint(REAL_MINT, 0)] }, payments: { "pay-1": paymentView({ kind: "payment", direction: "out", state: "failed", error: engineText("noSharedMint") }) } });
    renderApp(<PaymentBubble paymentId="pay-1" peerPubKey="peer" fallbackText="[a payment]" />, { language: "pt" });
    expect(screen.getByTestId("payment-state")).toHaveTextContent("Você não tem nenhum mint em comum com este contato");
  });

  // A mint that refuses a melt at once ("Lightning payment failed: no route"): its English stood alone (agents#2253).
  const refused = engineText("lightningRefused", { reason: "Lightning payment failed: no route" });

  it("a Lightning payment the mint refused, on the wallet page: no sats left, in Portuguese; the mint's words behind the ⓘ", async () => {
    const state = walletView({ mode: "testnet", mints: [mint(TEST_MINT, 9_500)], balance: 9_500 }) as WalletState;
    const { user, engine } = renderApp(<CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />, { language: "pt" });
    engine.on("walletQuoteInvoice", () => ({ quote: "melt-1", mint: TEST_MINT, amount: 300, feeReserve: 2 })).on("walletPayQuote", () => { throw new Error(refused); });
    await user.click(screen.getByTestId("wallet-send"));
    await user.type(screen.getByTestId("wallet-pay-input"), liveMainnetInvoice(300));
    await user.click(screen.getByRole("button", { name: /^Pagar 300 sats de teste$/ }));
    await user.click(await screen.findByTestId("wallet-pay-confirm"));
    const notice = await screen.findByTestId("wallet-error");
    expect(notice).toHaveTextContent("A mint recusou este pagamento Lightning" + "Nenhum sat saiu da sua carteira. Pode tentar de novo com segurança.");
    expect(notice).not.toHaveTextContent("no route");
    await user.click(screen.getByTestId("wallet-error-info"));
    expect(screen.getByTestId("wallet-error-details")).toHaveTextContent("The mint said: Lightning payment failed: no route");
  });

  it("a Lightning payment the mint refused, on a chat request: no sats left, in Portuguese", () => {
    fakeEngine.setState({ links: [linkView()], wallet: { mints: [mint(TEST_MINT, 9_500)] }, payments: { "req-1": paymentView({ kind: "request", direction: "in", state: "failed", error: refused }) } });
    renderApp(<PaymentBubble paymentId="req-1" peerPubKey="peer" fallbackText="[a request]" />, { language: "pt" });
    expect(screen.getByTestId("payment-state")).toHaveTextContent("A mint recusou este pagamento Lightning. Nenhum sat saiu da sua carteira.");
    expect(screen.getByTestId("payment-state")).not.toHaveTextContent("no route");
  });

  it("in English, the text is the engine's own, word for word", async () => {
    const { user, engine } = renderApp(<CashuWallet wallet={wallet.forNetwork("mainnet")} state={onNetwork("mainnet", { mints: [mint(REAL_MINT, 0)] })} rail="cashu" onOpenCashu={() => {}} />);
    engine.on("walletAddMint", () => { throw new Error(engineText("realMintOnTestnet")); });
    await user.type(screen.getByTestId("wallet-mint-url"), "https://mint.example.org");
    await user.click(screen.getByTestId("wallet-add-mint"));
    expect(await screen.findByTestId("wallet-error")).toHaveTextContent(/^This mint holds real sats: add it to a Mainnet Cashu wallet$/);
  });

});

import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { engineText } from "@ghostly/core";
import { PaymentBubble } from "../../components/PaymentBubble";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { networkState } from "../../components/walletCardData";
import { servicesPlatform, type WalletNetwork, type WalletState } from "../../lib/platform";
import { fakeEngine, linkView, paymentView, walletView } from "../fakeEngine";
import { lightningSource, mint, REAL_MINT, TEST_MINT } from "../payments/fixtures";
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
    expect(await screen.findByTestId("wallet-error")).toHaveTextContent("Este é um mint de teste, e seus sats não valem nada: adicione-o a uma carteira Cashu de Testnet");
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

  it("in English, the text is the engine's own, word for word", async () => {
    const { user, engine } = renderApp(<CashuWallet wallet={wallet.forNetwork("mainnet")} state={onNetwork("mainnet", { mints: [mint(REAL_MINT, 0)] })} rail="cashu" onOpenCashu={() => {}} />);
    engine.on("walletAddMint", () => { throw new Error(engineText("realMintOnTestnet")); });
    await user.type(screen.getByTestId("wallet-mint-url"), "https://mint.example.org");
    await user.click(screen.getByTestId("wallet-add-mint"));
    expect(await screen.findByTestId("wallet-error")).toHaveTextContent(/^This mint holds real sats: add it to a Mainnet Cashu wallet$/);
  });

});

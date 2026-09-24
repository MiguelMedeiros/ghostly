import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BitcoinWalletPanel } from "../../components/BitcoinWalletPanel";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { servicesPlatform, type WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { renderApp } from "../render";
import { offered, sourceView } from "./descriptors";

// covers: wallet.lightning.sources, wallet.onchain.sources

/** The wallet cards hand a source's form to the engine through the platform, as the web app does. */
describe("choosing a source from the wallet cards", () => {
  const wallet = servicesPlatform!.wallet;

  it("the Bitcoin card sends bitcoinSetSource with the provider and the typed values", async () => {
    const phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const state = walletView({ mode: "testnet", bitcoin: { ...sourceView({ mode: "testnet", offered: offered("onchain", "testnet") }), history: [] } }) as WalletState;
    const { user, engine } = renderApp(<BitcoinWalletPanel wallet={wallet} state={state} />);
    engine.on("bitcoinSetSource", () => undefined);
    expect(screen.getByTestId("bitcoin-empty")).toHaveTextContent("No Bitcoin source configured");
    await user.selectOptions(screen.getByRole("combobox", { name: "Bitcoin source" }), "bdk");
    await user.click(screen.getByRole("radio", { name: "Restore" }));
    await user.type(screen.getByLabelText("Recovery phrase"), phrase);
    await user.click(screen.getByRole("button", { name: "Use BDK wallet" }));
    expect(await screen.findByTestId("onchain-source-saved")).toBeInTheDocument();
    expect(engine.callsTo("bitcoinSetSource")).toEqual([{ providerId: "bdk", values: { network: "signet", esplora: "", script: "bip84", mnemonic: phrase } }]);
  });

  it("the Bitcoin card shows the engine's refusal", async () => {
    const state = walletView({ mode: "testnet", bitcoin: { ...sourceView({ mode: "testnet", offered: offered("onchain", "testnet") }), history: [] } }) as WalletState;
    const { user, engine } = renderApp(<BitcoinWalletPanel wallet={wallet} state={state} />);
    engine.on("bitcoinSetSource", () => { throw new Error("That recovery phrase is not valid (BIP39, English)"); });
    await user.selectOptions(screen.getByRole("combobox", { name: "Bitcoin source" }), "bdk");
    await user.click(screen.getByRole("radio", { name: "Restore" }));
    await user.type(screen.getByLabelText("Recovery phrase"), "not words");
    await user.click(screen.getByRole("button", { name: "Use BDK wallet" }));
    expect(await screen.findByTestId("onchain-source-error")).toHaveTextContent("That recovery phrase is not valid (BIP39, English)");
  });

  it("the Bitcoin card's Remove sends bitcoinClearSource", async () => {
    const state = walletView({ mode: "testnet", bitcoin: { ...sourceView({ mode: "testnet", offered: offered("onchain", "testnet"), providerId: "bdk", label: "BDK wallet", status: "ready", network: "signet" }), history: [] } }) as WalletState;
    const { user, engine } = renderApp(<BitcoinWalletPanel wallet={wallet} state={state} />);
    engine.on("bitcoinClearSource", () => undefined);
    await user.click(screen.getByTestId("onchain-source-clear"));
    expect(engine.callsTo("bitcoinClearSource")).toHaveLength(1);
  });

  it("the Lightning card sends lightningSetSource, and Back to Cashu mints sends lightningClearSource", async () => {
    const ln = { ...sourceView({ offered: offered("lightning", "mainnet"), providerId: "lnd", label: "LND node", status: "ready" as const, network: "bitcoin" as const }), recent: [] };
    const state = walletView({ lightning: ln }) as WalletState;
    const { user, engine } = renderApp(<CashuWallet wallet={wallet} state={state} rail="lightning" onOpenCashu={() => {}} />);
    engine.on("lightningSetSource", () => undefined).on("lightningClearSource", () => undefined);
    await user.selectOptions(screen.getByRole("combobox", { name: "Lightning source" }), "nwc");
    await user.type(screen.getByLabelText("Connection URI"), "nostr+walletconnect://wallet");
    await user.click(screen.getByRole("button", { name: "Use Nostr Wallet Connect" }));
    expect(await screen.findByTestId("lightning-source-saved")).toHaveTextContent("Nostr Wallet Connect is now your Lightning source.");
    expect(engine.callsTo("lightningSetSource")).toEqual([{ providerId: "nwc", values: { uri: "nostr+walletconnect://wallet" } }]);
    await user.click(screen.getByRole("button", { name: "Back to Cashu mints" }));
    expect(engine.callsTo("lightningClearSource")).toHaveLength(1);
  });
});

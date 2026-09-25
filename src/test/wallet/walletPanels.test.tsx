import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BitcoinWalletPanel } from "../../components/BitcoinWalletPanel";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { servicesPlatform, type WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { renderApp } from "../render";
import { offered, sourceView } from "./descriptors";
import { choose } from "../select";

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
    await choose(user, screen.getByRole("combobox", { name: "Bitcoin source" }), "bdk");
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
    await choose(user, screen.getByRole("combobox", { name: "Bitcoin source" }), "bdk");
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

  it("a Bitcoin source that does not answer shows Connecting…, its last balance, why, and Retry", async () => {
    const bitcoin = { ...sourceView({ mode: "testnet", offered: offered("onchain", "testnet"), providerId: "bdk", label: "BDK wallet", status: "connecting", config: { network: "signet", script: "bip84" }, secrets: ["mnemonic"],
      balance: 1_234, balanceAt: Date.UTC(2026, 8, 24), failures: 2, problem: "unreachable", retryAt: Date.now() + 4_000,
      error: "Could not connect to BDK wallet: the Esplora server at mempool.space did not answer in 20 s" }), history: [] };
    const { user, engine } = renderApp(<BitcoinWalletPanel wallet={wallet} state={walletView({ mode: "testnet", bitcoin }) as WalletState} />);
    engine.on("bitcoinRetrySource", () => undefined);
    const block = screen.getByTestId("bitcoin-connecting");
    expect(block).toHaveTextContent("Connecting to BDK wallet…");
    expect(screen.getByTestId("bitcoin-last-balance")).toHaveTextContent("Last known balance: 1,234 sats");
    expect(screen.getByTestId("bitcoin-connect-error")).toHaveTextContent("did not answer in 20 s · trying again by itself");
    expect(screen.getByTestId("onchain-source-status")).toHaveTextContent(/^Connecting… · Could not connect to BDK wallet: .* · trying again by itself$/);
    await user.click(screen.getByTestId("bitcoin-retry"));
    expect(engine.callsTo("bitcoinRetrySource")).toHaveLength(1);
    // The Source row has its own, next to Remove.
    expect(screen.getByTestId("onchain-source-retry")).toBeInTheDocument();
    expect(screen.getByTestId("onchain-source-clear")).toBeInTheDocument();
  });

  it("Change server offers the network's public servers and sends only the server, not the phrase", async () => {
    const bitcoin = { ...sourceView({ mode: "testnet", offered: offered("onchain", "testnet"), providerId: "bdk", label: "BDK wallet", status: "error", config: { network: "signet", script: "bip84" }, secrets: ["mnemonic"],
      failures: 4, problem: "unreachable", error: "Could not connect to BDK wallet: no public signet Esplora server answered" }), history: [] };
    const { user, engine } = renderApp(<BitcoinWalletPanel wallet={wallet} state={walletView({ mode: "testnet", bitcoin }) as WalletState} />);
    engine.on("bitcoinReconfigureSource", () => undefined);
    expect(screen.getByTestId("bitcoin-connecting")).toHaveTextContent("BDK wallet is not connected");
    await user.click(screen.getByTestId("bitcoin-change-server"));
    const form = screen.getByTestId("onchain-source-server-form");
    // Signet's public servers only (the source is on Signet), and no phrase to type again.
    const picks = [...form.querySelectorAll("[data-value]")].map((b) => b.getAttribute("data-value"));
    expect(picks).toEqual(["https://blockstream.info/signet/api", "https://mempool.space/signet/api"]);
    expect(form.querySelector("input[type=password]")).toBeNull();
    await user.click(screen.getByRole("button", { name: /blockstream\.info/ }));
    expect(screen.getByLabelText("Esplora server")).toHaveValue("https://blockstream.info/signet/api");
    await user.click(screen.getByTestId("onchain-source-server-save"));
    expect(await screen.findByTestId("onchain-source-saved")).toHaveTextContent("BDK wallet now uses that server.");
    expect(engine.callsTo("bitcoinReconfigureSource")).toEqual([{ values: { esplora: "https://blockstream.info/signet/api" } }]);
    expect(screen.queryByTestId("onchain-source-server-form")).toBeNull();
  });

  it("Change server shows the engine's refusal and keeps the form open", async () => {
    const bitcoin = { ...sourceView({ mode: "testnet", offered: offered("onchain", "testnet"), providerId: "bdk", label: "BDK wallet", status: "ready", network: "signet", config: { network: "signet", esplora: "https://mempool.space/signet/api" } }), history: [] };
    const { user, engine } = renderApp(<BitcoinWalletPanel wallet={wallet} state={walletView({ mode: "testnet", bitcoin }) as WalletState} />);
    engine.on("bitcoinReconfigureSource", () => { throw new Error("Could not connect to BDK wallet: wrong network: the Esplora server at x is on testnet4, not signet"); });
    // Connected: no Retry, but the server can still be changed.
    expect(screen.queryByTestId("onchain-source-retry")).toBeNull();
    await user.click(screen.getByTestId("onchain-source-change-server"));
    expect(screen.getByLabelText("Esplora server")).toHaveValue("https://mempool.space/signet/api");
    await user.click(screen.getByTestId("onchain-source-server-save"));
    expect(await screen.findByTestId("onchain-source-error")).toHaveTextContent("is on testnet4, not signet");
    expect(screen.getByTestId("onchain-source-server-form")).toBeInTheDocument();
  });

  it("the BDK form suggests the servers of the network chosen", async () => {
    const state = walletView({ mode: "testnet", bitcoin: { ...sourceView({ mode: "testnet", offered: offered("onchain", "testnet") }), history: [] } }) as WalletState;
    const { user } = renderApp(<BitcoinWalletPanel wallet={wallet} state={state} />);
    await choose(user, screen.getByRole("combobox", { name: "Bitcoin source" }), "bdk");
    const picks = () => [...screen.getByTestId("field-suggestions-esplora").querySelectorAll("[data-value]")].map((b) => b.getAttribute("data-value"));
    expect(picks()).toEqual(["https://blockstream.info/signet/api", "https://mempool.space/signet/api"]);
    await choose(user, screen.getByLabelText("Network"), "regtest");
    expect(picks()).toEqual(["http://127.0.0.1:47002"]);
    await user.click(screen.getByRole("button", { name: /e2e regtest stack/ }));
    expect(screen.getByLabelText("Esplora server")).toHaveValue("http://127.0.0.1:47002");
  });

  it("the Lightning card sends lightningSetSource, and Back to Cashu mints sends lightningClearSource", async () => {
    const ln = { ...sourceView({ offered: offered("lightning", "mainnet"), providerId: "lnd", label: "LND node", status: "ready" as const, network: "bitcoin" as const }), recent: [] };
    const state = walletView({ lightning: ln }) as WalletState;
    const { user, engine } = renderApp(<CashuWallet wallet={wallet} state={state} rail="lightning" onOpenCashu={() => {}} />);
    engine.on("lightningSetSource", () => undefined).on("lightningClearSource", () => undefined);
    await choose(user, screen.getByRole("combobox", { name: "Lightning source" }), "nwc");
    await user.type(screen.getByLabelText("Connection URI"), "nostr+walletconnect://wallet");
    await user.click(screen.getByRole("button", { name: "Use Nostr Wallet Connect" }));
    expect(await screen.findByTestId("lightning-source-saved")).toHaveTextContent("Nostr Wallet Connect is now your Lightning source.");
    expect(engine.callsTo("lightningSetSource")).toEqual([{ providerId: "nwc", values: { uri: "nostr+walletconnect://wallet" } }]);
    await user.click(screen.getByRole("button", { name: "Back to Cashu mints" }));
    expect(engine.callsTo("lightningClearSource")).toHaveLength(1);
  });
});

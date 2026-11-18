import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SPARK_PROVIDER, type PaymentReview as Review } from "@ghostly/core";
import type { FederationInfo } from "@ghostly/browser/engine/paymentAdapters/fedimintSdk";
import { TEST_MINTS } from "@ghostly/browser/shared/mints";
import { AccountBar } from "../../components/AccountBar";
import { ArkWalletPanel } from "../../components/ArkWalletPanel";
import { BarkWalletPanel } from "../../components/BarkWalletPanel";
import { BitcoinWalletPanel } from "../../components/BitcoinWalletPanel";
import { FedimintWalletPanel } from "../../components/FedimintWalletPanel";
import { PaymentBubble } from "../../components/PaymentBubble";
import { PaymentReview } from "../../components/PaymentReview";
import { SparkWalletPanel } from "../../components/SparkWalletPanel";
import { UsdtWalletPanel } from "../../components/UsdtWalletPanel";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { RemoveMintConfirm } from "../../components/wallet/RemoveMint";
import { WalletAway } from "../../components/wallet/WalletAway";
import { networkState } from "../../components/walletCardData";
import { Wallet } from "../../pages/Wallet";
import { servicesPlatform, type WalletNetwork, type WalletPlatform, type WalletState } from "../../lib/platform";
import { fakeEngine, linkView, paymentView, walletView } from "../fakeEngine";
import { arkReady, barkReady, bitcoinSource, lightningSource, mint, REAL_MINT, sparkReady, target, TEST_MINT, usdtReady } from "../payments/fixtures";
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
    expect(screen.getByTestId("bitcoin-last-balance")).toHaveTextContent("Last known balance: 1,234 test sats");
    expect(screen.getByTestId("bitcoin-connect-error")).toHaveTextContent("Couldn't connect to BDK wallet · trying again by itself");
    expect(screen.getByTestId("bitcoin-connect-error")).toHaveTextContent("did not answer in 20 s");
    expect(screen.getByTestId("onchain-source-status")).toHaveTextContent(/^Connecting… · Couldn't connect to BDK wallet\. .* · trying again by itself$/);
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

  it("a Lightning card keeps its source: no source to pick or clear; Retry goes to it", async () => {
    const ln = { ...sourceView({ offered: offered("lightning", "mainnet"), providerId: "lnd", label: "LND node", status: "error" as const, failures: 3, network: "bitcoin" as const }), recent: [] };
    const state = walletView({ lightning: ln }) as WalletState;
    const { user, engine } = renderApp(<CashuWallet wallet={wallet} state={state} rail="lightning" onOpenCashu={() => {}} />);
    engine.on("lightningRetrySource", () => undefined);
    expect(screen.getByTestId("lightning-source-current")).toHaveTextContent("LND node");
    expect(screen.queryByRole("combobox", { name: "Lightning source" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("lightning-source-clear")).not.toBeInTheDocument();
    expect(screen.queryByText(/a Mainnet wallet has its own|a Testnet wallet has its own/)).not.toBeInTheDocument();
    await user.click(screen.getByTestId("lightning-source-retry"));
    expect(engine.callsTo("lightningRetrySource")).toHaveLength(1);
  });
});

// covers: wallet.bark.mainnet, wallet.bark.create
describe("the Bark panel", () => {
  const onNetwork = (network: WalletNetwork, patch: Partial<WalletState>) => networkState(walletView(patch) as WalletState, network);
  const MAINNET = { network: "bitcoin" as const, provider: "https://ark.second.tech", address: "ark1pbark", terms: "https://second.tech/terms" };

  it("on Mainnet: Bitcoin only (no test network switch), Second's terms, and what the coins ask of their owner", async () => {
    const state = onNetwork("mainnet", { bark: barkReady({ ...MAINNET, balance: 0, expiry: { blocksLeft: 300, lifetime: 4032 } }) });
    const { user, engine } = renderApp(<BarkWalletPanel wallet={servicesPlatform!.wallet.forNetwork("mainnet")} state={state} />);
    expect(screen.getByTestId("bark-balance")).toHaveTextContent(/^0\s*sats/);
    expect(screen.getByTestId("bark-network")).toHaveTextContent("Bitcoin");
    expect(screen.queryByRole("radiogroup", { name: "Bark network" })).not.toBeInTheDocument();
    expect(screen.getByTestId("bark-terms")).toHaveAttribute("href", "https://second.tech/terms");
    const essentials = screen.getByTestId("bark-essentials");
    expect(within(essentials).getByTestId("bark-expiry")).toHaveTextContent("Coins last about 28 days on this server. Ghostly renews them close to expiry while it is open, so open it before then. The next one expires in about 2 days.");
    expect(within(essentials).getByTestId("bark-expiry")).toHaveClass("text-warn-ink");
    expect(within(essentials).getByTestId("bark-exit")).toHaveTextContent("If the server disappears, coins can still be taken back on-chain before they expire (a unilateral exit, paying on-chain fees), but Ghostly has no button for that yet, so keep amounts small.");
    // Another server, while empty, stays on Bitcoin.
    engine.on("barkCreate", () => undefined);
    await user.click(screen.getByRole("button", { name: "Change" }));
    await user.click(screen.getByRole("button", { name: "Use this server" }));
    expect(engine.callsTo("barkCreate")).toEqual([{ network: "bitcoin", provider: "https://ark.second.tech", explorer: "https://mempool.second.tech/api" }]);
  });

  it("says what it could not read, or why it is still connecting, in the app's language", () => {
    const stale = onNetwork("mainnet", { bark: barkReady({ ...MAINNET, error: "Could not read the balance, history from the Bark server. Last values may be stale." }) });
    const { unmount } = renderApp(<BarkWalletPanel wallet={{} as never} state={stale} />, { language: "pt" });
    expect(screen.getByText("Não foi possível ler o saldo, o histórico do servidor Bark")).toBeInTheDocument();
    expect(screen.getByText("Os valores mostrados podem estar desatualizados.")).toBeInTheDocument();
    unmount();
    const connecting = onNetwork("mainnet", { bark: barkReady({ ...MAINNET, locked: true, error: "Connecting to Bark… The Bark server is not answering" }) });
    renderApp(<BarkWalletPanel wallet={{} as never} state={connecting} />, { language: "pt" });
    expect(screen.getByTestId("bark-connecting")).toHaveTextContent("Conectando ao Bark…" + "O servidor Bark não está respondendo");
  });

  it("with no coin yet, says how long coins last and nothing about a next expiry", () => {
    const state = onNetwork("mainnet", { bark: barkReady({ ...MAINNET, expiry: { lifetime: 4032 } }) });
    renderApp(<BarkWalletPanel wallet={{} as never} state={state} />);
    expect(screen.getByTestId("bark-expiry")).toHaveTextContent(/^Coins last about 28 days on this server\. Ghostly renews them close to expiry while it is open, so open it before then\.$/);
    expect(screen.getByTestId("bark-expiry")).not.toHaveClass("text-warn-ink");
  });

  it("on Testnet: the test networks only, no terms, and the exit line without the real-money advice", () => {
    const state = onNetwork("testnet", { bark: barkReady({ network: "signet", balance: 0, expiry: { blocksLeft: 100, lifetime: 144 } }) });
    renderApp(<BarkWalletPanel wallet={{} as never} state={state} />);
    const networks = screen.getByRole("radiogroup", { name: "Bark network" });
    expect(within(networks).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Signet", "Regtest"]);
    expect(screen.queryByTestId("bark-terms")).not.toBeInTheDocument();
    expect(screen.getByTestId("bark-expiry")).toHaveTextContent("Coins last about 1 day on this server.");
    expect(screen.getByTestId("bark-expiry")).toHaveTextContent("The next one expires in less than a day.");
    expect(screen.getByTestId("bark-exit")).not.toHaveTextContent("keep amounts small");
  });
});

// covers: wallet.spark.mainnet-key, wallet.spark.send, wallet.spark.lightning, wallet.instances.networks
describe("the Spark panel", () => {
  /** Made by the Breez SDK on Breez's regtest: a wallet's address, and an invoice of 1234 sats ("probe") from it. */
  const ADDRESS = "sparkrt1pgss87y4e569hncpt9649q5s6x7c3vv9lqwrjlucxfl3a3kk355a3pfkwf2mtr";
  const INVOICE = "sparkrt1pgss87y4e569hncpt9649q5s6x7c3vv9lqwrjlucxfl3a3kk355a3pfkzg5qsqgjzqq6p4sscrm8avymnelqhzrus7wz5ptswfhkyef6qcydm9xh65rzyqcg6gy35sxa3w5e20exjmr8xhyl96u3cxqk9ttgwes2xkfepzpp5nmw3zu5aczluq5t2fly3venjcv3cn9fvmtjgwcaae4fw2rqw4fy0nwd082rg0zclp2";
  const wallet = servicesPlatform!.wallet;
  const ready = (patch: Partial<NonNullable<WalletState["spark"]>> = {}, state: Partial<WalletState> = {}) =>
    walletView({ mode: "testnet", spark: { configured: true, locked: false, network: "regtest", address: ADDRESS, balance: 5_000, history: [], ...patch }, ...state }) as WalletState;
  const review = (amount: number, address: string) => ({ id: "rv-1", method: "spark", network: "regtest", provider: SPARK_PROVIDER, asset: "BTC", unit: "sat", address, expiresAt: Date.now() + 60_000,
    payee: address, amount, fee: 0, feeCap: 100, createdAt: Date.now(), state: "pending" });

  it("Mainnet asks for a Breez API key, labelled real bitcoin, and opens the wallet with it", async () => {
    const state = walletView({ spark: { configured: false, locked: true, balance: 0, network: "bitcoin", needsKey: true, unavailable: "key" } }) as WalletState;
    const { user, engine } = renderApp(<SparkWalletPanel wallet={wallet} state={state} />);
    engine.on("sparkCreate", () => undefined);
    expect(screen.getByTestId("spark-needs-key")).toHaveTextContent("Mainnet moves real bitcoin");
    expect(screen.getByTestId("spark-mainnet-create")).toBeDisabled();
    await user.type(screen.getByLabelText("Breez API key"), "breez-key");
    await user.click(screen.getByTestId("spark-mainnet-create"));
    expect(engine.callsTo("sparkCreate")).toEqual([{ network: "bitcoin", apiKey: "breez-key" }]);
  });

  it("without a key, points to a Testnet Spark wallet made with New, not to a switch of the wallets", () => {
    const state = walletView({ spark: { configured: false, locked: true, balance: 0, network: "bitcoin", needsKey: true, unavailable: "key" } }) as WalletState;
    renderApp(<SparkWalletPanel wallet={wallet} state={state} />);
    expect(screen.getByTestId("spark-needs-key")).toHaveTextContent("Or create a Testnet Spark wallet with New");
    expect(screen.getByTestId("spark-needs-key").textContent).not.toMatch(/switch/i);
  });

  it("a Mainnet wallet says it holds real bitcoin, counted in plain sats", () => {
    renderApp(<SparkWalletPanel wallet={wallet} state={ready({ network: "bitcoin" }, { mode: "mainnet" })} />);
    expect(screen.getByTestId("spark-mainnet-label")).toHaveTextContent("real bitcoin");
    expect(screen.getByTestId("spark-balance")).toHaveTextContent(/^5,000\s*sats/);
  });

  it("shows the balance in test sats and the wallet's own address to receive on", () => {
    renderApp(<SparkWalletPanel wallet={wallet} state={ready()} />);
    expect(screen.getByTestId("spark-balance")).toHaveTextContent(/^5,000\s*test sats/);
    expect(screen.getByTestId("spark-address")).toHaveTextContent(ADDRESS);
    expect(screen.getByTestId("spark-address-copy")).toBeInTheDocument();
    expect(screen.queryByTestId("spark-address-link"), "no scheme a wallet agrees on: no broken link").toBeNull();
  });

  it("sends to a Spark address for the amount typed, through a review", async () => {
    const { user, engine } = renderApp(<SparkWalletPanel wallet={wallet} state={ready()} />);
    engine.on("preparePayment", ({ amount, target }) => review(amount, target.address) as never);
    await user.click(screen.getByTestId("wallet-send"));
    await user.type(screen.getByLabelText("Spark address or invoice"), ADDRESS);
    await user.type(screen.getByTestId("spark-amount"), "700");
    await user.click(screen.getByTestId("spark-review"));
    expect(engine.callsTo("preparePayment")).toEqual([expect.objectContaining({ amount: 700, target: expect.objectContaining({ method: "spark", network: "regtest", provider: SPARK_PROVIDER, address: ADDRESS }) })]);
    expect(await screen.findByRole("button", { name: "Approve payment" })).toBeInTheDocument();
  });

  it("an invoice names its amount in test sats and its memo: nothing to type", async () => {
    const { user, engine } = renderApp(<SparkWalletPanel wallet={wallet} state={ready()} />);
    engine.on("preparePayment", ({ amount, target }) => review(amount, target.address) as never);
    await user.click(screen.getByTestId("wallet-send"));
    await user.click(screen.getByLabelText("Spark address or invoice"));
    await user.paste(INVOICE);
    expect(screen.getByTestId("spark-invoice-summary")).toHaveTextContent("Invoice for 1,234 test sats · probe");
    expect(screen.queryByTestId("spark-amount")).toBeNull();
    await user.click(screen.getByTestId("spark-review"));
    expect(engine.callsTo("preparePayment")[0]).toMatchObject({ amount: 1_234, target: { address: INVOICE } });
  });

  it("refuses what is not a Spark string of its network before any review", async () => {
    const { user } = renderApp(<SparkWalletPanel wallet={wallet} state={ready()} />);
    await user.click(screen.getByTestId("wallet-send"));
    await user.type(screen.getByLabelText("Spark address or invoice"), "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080");
    expect(screen.getByTestId("spark-address-invalid")).toHaveTextContent("not a Spark regtest address or invoice");
    expect(screen.getByTestId("spark-review")).toBeDisabled();
  });

  it("offers the same wallet as the Lightning source, and says so once it is", async () => {
    const { user, engine } = renderApp(<SparkWalletPanel wallet={wallet} state={ready()} />);
    engine.on("sparkUseForLightning", () => undefined);
    await user.click(screen.getByTestId("spark-use-lightning"));
    expect(engine.callsTo("sparkUseForLightning")).toHaveLength(1);
  });

  it("with Breez as the Lightning source, it is in use; and the history lists what moved", () => {
    const history = [{ id: "t1", direction: "in" as const, amount: 1_200, fee: 0, at: Date.UTC(2026, 8, 24), status: "completed" as const, via: "spark" as const, memo: "lunch" },
      { id: "t2", direction: "out" as const, amount: 300, fee: 0, at: Date.UTC(2026, 8, 24), status: "pending" as const, via: "lightning" as const }];
    renderApp(<SparkWalletPanel wallet={wallet} state={ready({ history }, { lightning: { mode: "testnet", providerId: "breez", status: "ready", offered: [], recent: [] } as WalletState["lightning"] })} />);
    expect(screen.getByTestId("spark-lightning-on")).toHaveTextContent("In use");
    const rows = screen.getAllByTestId("spark-history-row");
    expect(rows[0]).toHaveTextContent("+1,200 test satsSpark · lunch");
    expect(rows[1]).toHaveTextContent("−300 test satsLightning · pending");
  });

  it("a history row writes its fee like its amount, and what is not completed in the app's language", async () => {
    const history = [{ id: "t1", direction: "out" as const, amount: 12_000, fee: 1_500, at: Date.UTC(2026, 8, 24), status: "pending" as const, via: "lightning" as const },
      { id: "t2", direction: "out" as const, amount: 300, fee: 0, at: Date.UTC(2026, 8, 24), status: "failed" as const, via: "spark" as const }];
    const english = renderApp(<SparkWalletPanel wallet={wallet} state={ready({ history })} />);
    expect(screen.getAllByTestId("spark-history-row")[0]).toHaveTextContent("Lightning · pending · fee 1,500");
    expect(screen.getAllByTestId("spark-history-row")[1]).toHaveTextContent("Spark · failed");
    english.unmount();
    renderApp(<SparkWalletPanel wallet={wallet} state={ready({ history })} />, { language: "pt" });
    await screen.findByText("Histórico");
    expect(screen.getAllByTestId("spark-history-row")[0]).toHaveTextContent("Lightning · pendente · taxa 1.500");
    expect(screen.getAllByTestId("spark-history-row")[1]).toHaveTextContent("Spark · falhou");
  });
});

// covers: wallet.onchain.bdk.send, wallet.onchain.sources, wallet.ark.recover, wallet.ark.send, wallet.bark.send, wallet.ark.boarding
describe("the Bitcoin, Ark and Bark panels from the keyboard", () => {
  /**
   * The Bitcoin, Ark and Bark panels from the keyboard: the button pressed keeps the focus while it works (busy, not
   * disabled: a disabled one drops it to the page in Chromium) and after a refusal; the panel's other buttons wait,
   * disabled. A Review payment hands the focus to the review it opens.
   */
  const later = <T,>() => { let answer!: (value: T) => void, refuse!: (e: Error) => void; const promise = new Promise<T>((resolve, reject) => { answer = resolve; refuse = reject; }); return { promise, answer, refuse }; };
  const busy = (button: HTMLElement) => {
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toBeEnabled();
    expect(button).toHaveFocus();
  };
  const done = (button: HTMLElement) => waitFor(() => expect(button).not.toHaveAttribute("aria-busy"));
  const press = async (user: { keyboard(keys: string): Promise<void> }, button: HTMLElement) => { button.focus(); await user.keyboard("{Enter}"); };
  const onTestnet = (patch: Partial<WalletState>) => networkState(walletView(patch) as WalletState, "testnet");
  const withMethods = (methods: Partial<WalletPlatform>): WalletPlatform => Object.assign(Object.create(servicesPlatform!.wallet), methods);
  const review = (method: Review["method"], network: string): Review =>
    ({ method, network, provider: "p", asset: "BTC", unit: "sat", address: "addr", expiresAt: Date.now() + 60_000, id: "review-1", payee: "addr", amount: 21, fee: 1, feeCap: 10, createdAt: 0, state: "pending" }) as Review;

  describe("the Bitcoin panel", () => {
    it("Get an address is busy where pressed and keeps the keys after a refusal; Refresh now waits", async () => {
      const asked = later<string>();
      const wallet = withMethods({ bitcoinReceiveAddress: () => asked.promise as never });
      const { user } = renderApp(<BitcoinWalletPanel wallet={wallet} state={onTestnet({ bitcoin: bitcoinSource({ mode: "testnet" }) })} />);
      const get = screen.getByTestId("bitcoin-new-address");
      await press(user, get);
      busy(get);
      expect(screen.getByRole("button", { name: "Refresh now" })).toBeDisabled();
      asked.refuse(new Error("The node did not answer"));
      await done(get);
      expect(get).toHaveFocus();
    });

    it("Retry, not connected, is busy where pressed and keeps the keys after a refusal", async () => {
      const tried = later<void>();
      const wallet = withMethods({ bitcoinRetrySource: () => tried.promise });
      const { user } = renderApp(<BitcoinWalletPanel wallet={wallet} state={onTestnet({ bitcoin: bitcoinSource({ mode: "testnet", status: "error", label: "Electrum" }) })} />);
      const retry = screen.getByTestId("bitcoin-retry");
      await press(user, retry);
      busy(retry);
      tried.refuse(new Error("Still down"));
      await done(retry);
      expect(retry).toHaveFocus();
    });

    it("Review payment is busy where pressed and keeps the keys after a refusal; the review it opens takes them", async () => {
      let prepared = later<Review>();
      const wallet = withMethods({ preparePayment: () => prepared.promise });
      const { user } = renderApp(<BitcoinWalletPanel wallet={wallet} state={onTestnet({ bitcoin: bitcoinSource({ mode: "testnet" }) })} />);
      await user.click(screen.getByRole("tab", { name: "Send" }));
      await user.type(screen.getByRole("textbox", { name: "Bitcoin recipient address" }), "tb1qrecipient");
      await user.type(screen.getByTestId("bitcoin-amount"), "21");
      const open = screen.getByRole("button", { name: "Review payment" });
      await press(user, open);
      busy(open);
      prepared.refuse(new Error("Fee too high"));
      await done(open);
      expect(open).toHaveFocus();

      prepared = later();
      await user.keyboard("{Enter}");
      prepared.answer(review("bitcoin", "signet"));
      await waitFor(() => expect(screen.getByRole("heading", { name: /Review payment/ })).toHaveFocus());
    });
  });

  describe("the Ark panel", () => {
    it("Recover is busy where pressed and keeps the keys after a refusal", async () => {
      const recovered = later<void>();
      const wallet = withMethods({ arkRecover: () => recovered.promise as never });
      const { user } = renderApp(<ArkWalletPanel wallet={wallet} state={onTestnet({ ark: arkReady({ recoverable: 900 }) })} />);
      const recover = screen.getByTestId("ark-recover");
      await press(user, recover);
      busy(recover);
      recovered.refuse(new Error("The server did not answer"));
      await done(recover);
      expect(recover).toHaveFocus();
    });

    it("Review payment is busy where pressed; the review it opens takes the keys", async () => {
      const prepared = later<Review>();
      const wallet = withMethods({ preparePayment: () => prepared.promise });
      const { user } = renderApp(<ArkWalletPanel wallet={wallet} state={onTestnet({ ark: arkReady({ provider: "https://ark.example" }) })} />);
      await user.click(screen.getByRole("tab", { name: "Send" }));
      await user.type(screen.getByRole("textbox", { name: "Ark recipient address" }), "tark1recipient");
      await user.type(screen.getByRole("textbox", { name: /^Amount/ }), "21");
      const open = screen.getByRole("button", { name: "Review payment" });
      await press(user, open);
      busy(open);
      prepared.answer(review("arkade", "mutinynet"));
      await waitFor(() => expect(screen.getByRole("heading", { name: /Review payment/ })).toHaveFocus());
    });
  });

  describe("the Bark panel", () => {
    it("Move into Ark is busy where pressed and keeps the keys after a refusal", async () => {
      const boarded = later<void>();
      const wallet = withMethods({ barkBoard: () => boarded.promise as never });
      const { user } = renderApp(<BarkWalletPanel wallet={wallet} state={onTestnet({ bark: barkReady({ onchain: 5_000 }) })} />);
      const board = screen.getByTestId("bark-board");
      await press(user, board);
      busy(board);
      expect(board).toHaveTextContent("Moving…");
      boarded.refuse(new Error("The server did not answer"));
      await done(board);
      expect(board).toHaveFocus();
    });

    it("Review payment is busy where pressed; the review it opens takes the keys", async () => {
      const prepared = later<Review>();
      const wallet = withMethods({ preparePayment: () => prepared.promise });
      const { user } = renderApp(<BarkWalletPanel wallet={wallet} state={onTestnet({ bark: barkReady({ provider: "https://bark.example" }) })} />);
      await user.click(screen.getByRole("tab", { name: "Send" }));
      await user.type(screen.getByRole("textbox", { name: "Bark recipient address" }), "tark1recipient");
      await user.type(screen.getByRole("textbox", { name: /^Amount/ }), "21");
      const open = screen.getByRole("button", { name: "Review payment" });
      await press(user, open);
      busy(open);
      prepared.answer(review("bark", "signet"));
      await waitFor(() => expect(screen.getByRole("heading", { name: /Review payment/ })).toHaveFocus());
    });
  });
});

// covers: wallet.spark.send, wallet.spark.lightning, wallet.spark.mainnet-key, wallet.usdt.send
describe("the Spark and USDT panels from the keyboard", () => {
  /**
   * The Spark and USDT panels from the keyboard: the button pressed keeps the focus while it works (busy, not disabled:
   * a disabled one drops it to the page in Chromium) and after a refusal; the panel's other buttons wait, disabled. A
   * Review payment hands the focus to the review it opens.
   */
  const later = <T,>() => { let answer!: (value: T) => void, refuse!: (e: Error) => void; const promise = new Promise<T>((resolve, reject) => { answer = resolve; refuse = reject; }); return { promise, answer, refuse }; };
  const busy = (button: HTMLElement) => {
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toBeEnabled();
    expect(button).toHaveFocus();
  };
  const done = (button: HTMLElement) => waitFor(() => expect(button).not.toHaveAttribute("aria-busy"));
  const press = async (user: { keyboard(keys: string): Promise<void> }, button: HTMLElement) => { button.focus(); await user.keyboard("{Enter}"); };
  const onTestnet = (patch: Partial<WalletState>) => networkState(walletView(patch) as WalletState, "testnet");
  const withMethods = (methods: Partial<WalletPlatform>): WalletPlatform => Object.assign(Object.create(servicesPlatform!.wallet), methods);
  const review = (method: Review["method"], network: string): Review =>
    ({ method, network, provider: "p", asset: "BTC", unit: "sat", address: "addr", expiresAt: Date.now() + 60_000, id: "review-1", payee: "addr", amount: 21, fee: 1, feeCap: 10, createdAt: 0, state: "pending" }) as Review;

  /** A Spark address on Breez's regtest (as walletPanels.test.tsx has it). */
  const SPARK_ADDRESS = "sparkrt1pgss87y4e569hncpt9649q5s6x7c3vv9lqwrjlucxfl3a3kk355a3pfkwf2mtr";

  describe("the Spark panel", () => {
    it("Review payment is busy where pressed and keeps the keys after a refusal; the review it opens takes them", async () => {
      let prepared = later<Review>();
      const wallet = withMethods({ preparePayment: () => prepared.promise });
      const { user } = renderApp(<SparkWalletPanel wallet={wallet} state={onTestnet({ spark: sparkReady() })} />);
      await user.click(screen.getByRole("tab", { name: "Send" }));
      await user.type(screen.getByLabelText("Spark address or invoice"), SPARK_ADDRESS);
      await user.type(screen.getByTestId("spark-amount"), "21");
      const open = screen.getByTestId("spark-review");
      await press(user, open);
      busy(open);
      prepared.refuse(new Error("Not enough"));
      await done(open);
      expect(open).toHaveFocus();

      prepared = later();
      await user.keyboard("{Enter}");
      prepared.answer(review("spark", "regtest"));
      await waitFor(() => expect(screen.getByRole("heading", { name: /Review payment/ })).toHaveFocus());
    });

    it("Use for Lightning too is busy where pressed and keeps the keys after a refusal", async () => {
      const used = later<void>();
      const wallet = withMethods({ sparkUseForLightning: () => used.promise as never });
      const { user } = renderApp(<SparkWalletPanel wallet={wallet} state={onTestnet({ spark: sparkReady() })} />);
      const use = screen.getByTestId("spark-use-lightning");
      await press(user, use);
      busy(use);
      used.refuse(new Error("Breez did not answer"));
      await done(use);
      expect(use).toHaveFocus();
    });

    it("Open a Mainnet Spark wallet is busy where pressed and keeps the keys after a refusal", async () => {
      const created = later<void>();
      const wallet = withMethods({ sparkCreate: () => created.promise as never });
      const state = walletView({ spark: { configured: false, locked: true, balance: 0, network: "bitcoin", needsKey: true, unavailable: "key" } }) as WalletState;
      const { user } = renderApp(<SparkWalletPanel wallet={wallet} state={state} />);
      await user.type(screen.getByLabelText("Breez API key"), "breez-key");
      const create = screen.getByTestId("spark-mainnet-create");
      await press(user, create);
      busy(create);
      created.refuse(new Error("The key was refused"));
      await done(create);
      expect(create).toHaveFocus();
    });
  });

  describe("the USDT panel", () => {
    it("Unlock USDT is busy where pressed and keeps the keys after a refusal", async () => {
      const unlocked = later<void>();
      const wallet = withMethods({ usdtUnlock: () => unlocked.promise as never });
      const { user } = renderApp(<UsdtWalletPanel wallet={wallet} state={onTestnet({ usdt: usdtReady({ locked: true, network: "sepolia" }) })} />);
      await user.type(screen.getByLabelText("USDT wallet password"), "secret");
      const unlock = screen.getByRole("button", { name: "Unlock USDT" });
      await press(user, unlock);
      busy(unlock);
      unlocked.refuse(new Error("Wrong password"));
      await done(unlock);
      expect(unlock).toHaveFocus();
    });

    it("Review payment is busy where pressed and keeps the keys after a refusal; the review it opens takes them", async () => {
      let prepared = later<Review>();
      const wallet = withMethods({ preparePayment: () => prepared.promise });
      const { user } = renderApp(<UsdtWalletPanel wallet={wallet} state={onTestnet({ usdt: usdtReady({ network: "sepolia", address: "0xme" }) })} />);
      await user.click(screen.getByRole("tab", { name: "Send" }));
      await user.type(screen.getByRole("textbox", { name: "USDT recipient address" }), "0xrecipient");
      await user.type(screen.getByRole("textbox", { name: /^Amount/ }), "2");
      const open = screen.getByRole("button", { name: "Review payment" });
      await press(user, open);
      busy(open);
      prepared.refuse(new Error("Gas too high"));
      await done(open);
      expect(open).toHaveFocus();

      prepared = later();
      await user.keyboard("{Enter}");
      prepared.answer(review("usdt", "sepolia"));
      await waitFor(() => expect(screen.getByRole("heading", { name: /Review payment/ })).toHaveFocus());
    });
  });
});

// covers: wallet.ark.recover
describe("the Ark panel's expired coins", () => {
  /**
   * Ark coins whose batch expired before they were renewed: until the server sweeps that batch they can be neither
   * spent nor recovered, so the panel says they wait and offers no Recover; once swept, Recover.
   */
  const wallet = servicesPlatform!.wallet;
  const panel = (ark: Parameters<typeof arkReady>[0]) =>
    renderApp(<ArkWalletPanel wallet={wallet} state={networkState(walletView({ ark: arkReady({ network: "regtest", ...ark }) }) as WalletState, "testnet")} />);

  it("waiting for the sweep: says so, with the why behind the info button, and no Recover", async () => {
    panel({ balance: 0, sweeping: 9_900 });
    const waiting = screen.getByTestId("ark-sweeping");
    expect(waiting).toHaveTextContent(/^9,900 test sats expired\. You can recover them once the Ark server has swept their batch\.$/);
    expect(screen.queryByTestId("ark-recover")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("row-info"));
    expect(screen.getByTestId("row-info-text")).toHaveTextContent("takes their batch back on-chain");
  });

  it("swept: Recover", () => {
    panel({ balance: 0, recoverable: 9_900 });
    expect(screen.getByTestId("ark-recoverable")).toHaveTextContent("9,900 test sats expired before they were renewed");
    expect(screen.getByTestId("ark-recover")).toBeEnabled();
    expect(screen.queryByTestId("ark-sweeping")).not.toBeInTheDocument();
  });

  it("swept but too few for a recovery of their own: said so, no Recover", () => {
    panel({ balance: 9_300, small: 250 });
    expect(screen.getByTestId("ark-small")).toHaveTextContent(/^250 test sats expired, too few to recover on their own\./);
    expect(screen.queryByTestId("ark-recover")).not.toBeInTheDocument();
  });
});

// covers: wallet.instances.networks, wallet.usdt.send
describe("the USDT card's payments", () => {
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

// covers: wallet.mode, app.i18n
describe("in Arabic, a wallet's balance keeps its number apart from its unit", () => {
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

// covers: wallet.mode, wallet.cashu.test-sats, wallet.instances.networks
describe("the wallets' Testnet wording", () => {
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

    it("Cashu on a Testnet wallet: its mints and its amount field say test sats too", () => {
      const state = onNetwork("testnet", { mints: [mint(TEST_MINT, 21)], balance: 21 });
      renderApp(<CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />);
      expect(screen.getByTestId("mint-row")).toHaveTextContent(/21\s*test sats/);
      expect(screen.getByTestId("wallet-receive-amount")).toHaveAccessibleName("Amount in test sats");
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
});

// covers: payments.chat.review, wallet.lightning.sources
describe("a payment's words, not the engine's", () => {
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

    it("the Cashu wallet's list keeps what is left to do or read, not the settled or cancelled ones", () => {
      const states = ["pending", "submitted", "unknown", "failed", "settled", "cancelled"] as const;
      const intents = states.map((state, i) => review({ id: `r${i}`, state, amount: 10 + i }));
      renderApp(<CashuWallet wallet={wallet} state={onNetwork("testnet", { mints: [mint(TEST_MINT, 0)], intents })} rail="cashu" onOpenCashu={() => {}} />);
      expect(screen.getAllByTestId("wallet-intent").map((b) => b.textContent?.split(" ")[0])).toEqual(["10", "11", "12", "13"]);
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
});

// covers: wallet.history, app.i18n
describe("in Arabic, a wallet history's signed amounts read left to right", () => {
  /**
   * A movement's sign stays at its number's left in Arabic too: the digits are Latin in every language, and a bare "−"
   * at the start of a right-to-left line goes after them ("1,000−"). Each history writes the signed amount as its own
   * left-to-right run.
   */
  const runs = (row: HTMLElement) => [...row.querySelectorAll('[dir="ltr"]')].map((el) => el.textContent);

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

// covers: app.i18n
describe("names in a wallet's lines, in Arabic, each isolated", () => {
  /*
   * A wallet's, a device's, a mint's or a federation's name in a wallet's lines, in a language of the other direction:
   * each isolated, as the Apps lines' names are. Put in plainly, the punctuation at a name's end took the sentence's
   * direction and was drawn on the other side: "على !MacBook" in Arabic.
   */

  const PHONE = "Phone!";
  /** The <bdi>s holding exactly this name inside the element. */
  const isolated = (el: HTMLElement, name: string) => [...el.querySelectorAll("bdi")].filter(bdi => bdi.textContent === name).length;

  it("a wallet at home on another device names the wallet and the device", () => {
    renderApp(<WalletAway wallet={{ type: "lightning", name: "Home!", home: { device: PHONE } }} />, { language: "ar" });
    const panel = screen.getByTestId("wallet-away");
    expect(isolated(panel, "Home!")).toBe(1);
    // The title's device is a <bdi>; the line naming both holds the device between FSI and PDI.
    expect(isolated(panel, PHONE)).toBe(1);
    expect(panel.textContent).toContain(`⁨${PHONE}⁩`);
  });

  it("an Ark wallet at home elsewhere names the device in its expiry and backup lines", () => {
    renderApp(<WalletAway wallet={{ type: "arkade", name: "Ark", home: { device: PHONE, expiresAt: Date.UTC(2026, 9, 12) } }} platform={{} as WalletPlatform} />, { language: "ar" });
    expect(isolated(screen.getByTestId("wallet-away-expires"), PHONE)).toBe(1);
    expect(isolated(screen.getByTestId("wallet-away-backup"), PHONE)).toBe(1);
  });

  it("Remove asks about the mint by its name", () => {
    const state = walletView({ mints: [mint("https://a.example", 0), { ...mint("https://b.example", 0), name: "Minibits!" }] }) as WalletState;
    renderApp(<RemoveMintConfirm mint={state.mints[1]!} wallet={{} as WalletPlatform} state={state} onClose={() => {}} />, { language: "ar" });
    expect(isolated(screen.getByTestId("mint-remove-confirm"), "Minibits!")).toBe(1);
  });

  it("Join names the federation", async () => {
    const facts = { federationId: "b".repeat(64), name: "Beta!", guardians: [{ id: 0, name: "g0" }], consensusVersion: "2.1", network: "regtest", modules: ["ln", "mint"] } as never as FederationInfo;
    const wallet = { fedimintPreview: async () => facts } as Partial<WalletPlatform> as WalletPlatform;
    const state = walletView({ mode: "testnet", fedimint: { federations: [], balance: 0, history: [] } as never }) as WalletState;
    const { user } = renderApp(<FedimintWalletPanel wallet={wallet} state={state} />, { language: "ar" });
    await user.type(screen.getByTestId("fedimint-invite"), "fed1beta");
    await user.click(screen.getByTestId("fedimint-preview"));
    await waitFor(() => expect(isolated(screen.getByTestId("fedimint-join"), "Beta!")).toBe(1));
  });

  it("a card spending another's balance names that card", () => {
    renderApp(<CashuWallet wallet={{} as WalletPlatform} state={walletView() as WalletState} rail="lightning" sharedWith="Home!" onOpenCashu={() => {}} />, { language: "ar" });
    expect(isolated(screen.getByTestId("wallet-shared-balance"), "Home!")).toBe(1);
  });
});

// covers: devices.handoff.wallets
describe("the away panel", () => {
  /*
   * A wallet at home on another device (WISP 06 § Wallets that stay home), in place of its panel: where it can be used,
   * when Ark and Bark coins expire there, and the recovery phrase and backup file, read here without opening the wallet:
   * if that device is lost, the funds are reachable from them.
   */

  const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

  function platform(): WalletPlatform & { arkBackup: ReturnType<typeof vi.fn>; arkExportBackup: ReturnType<typeof vi.fn> } {
    return { arkBackup: vi.fn(async () => ({ mnemonic: PHRASE })), arkExportBackup: vi.fn(async () => "{}") } as never;
  }

  it("an Ark wallet: where it is, when its coins expire there, and its recovery phrase shown on Show, the wallet never opened", async () => {
    const wallet = platform();
    const { user } = renderApp(<WalletAway wallet={{ type: "arkade", name: "Ark", home: { device: "MacBook", expiresAt: Date.UTC(2026, 9, 12) } }} platform={wallet} />);
    const panel = screen.getByTestId("wallet-away");
    expect(panel).toHaveTextContent("MacBook");
    expect(screen.getByTestId("wallet-away-expires")).toHaveTextContent("2026");
    expect(screen.getByTestId("wallet-away-backup")).toHaveTextContent("MacBook");
    // The phrase and the backup file rows, as every self-custodial wallet has them; no restore here.
    expect(screen.getByTestId("ark-recovery-show")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
    await user.click(screen.getByTestId("ark-recovery-show"));
    expect(await screen.findByTestId("ark-recovery")).toHaveTextContent(PHRASE);
    expect(wallet.arkBackup).toHaveBeenCalledTimes(1);
  });

  it("a Lightning card, or no wallet calls to read with: no phrase and no backup rows", () => {
    renderApp(<WalletAway wallet={{ type: "lightning", name: "LND", home: { device: "MacBook" } }} platform={platform()} />);
    expect(screen.getByTestId("wallet-away")).toHaveTextContent("LND");
    expect(screen.queryByTestId("wallet-away-backup")).not.toBeInTheDocument();
    expect(screen.queryByTestId("wallet-away-expires")).not.toBeInTheDocument();
  });

  it("an unnamed home device is another device; without a platform there is nothing to read", () => {
    renderApp(<WalletAway wallet={{ type: "bark", name: "Bark", home: { device: "" } }} />);
    expect(screen.getByTestId("wallet-away")).toHaveTextContent("On the device that holds it");
    expect(screen.queryByTestId("wallet-away-backup")).not.toBeInTheDocument();
  });
});

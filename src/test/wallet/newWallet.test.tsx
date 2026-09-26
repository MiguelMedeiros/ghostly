import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WalletInstanceView, WalletOffer, WalletView } from "@ghostly/browser/shared/types";
import { NETWORK_KEY, Wallet } from "../../pages/Wallet";
import { walletView } from "../fakeEngine";
import { renderApp } from "../render";
import { arkReady, barkReady, mint, REAL_MINT, TEST_MINT, usdtReady } from "../payments/fixtures";
import { offered } from "./descriptors";
import { choose } from "../select";

// covers: wallet.instances.create, wallet.instances.networks, wallet.instances.sections, wallet.deck

const made = (type: WalletInstanceView["type"], network: WalletInstanceView["network"]): WalletInstanceView => ({ id: `${type}:${network}`, type, network, config: {} });
/** What New offers when nothing is made yet: every kind, Spark and Fedimint Testnet only. */
const offers = (patch: Partial<Record<string, Partial<WalletOffer>>> = {}): WalletOffer[] =>
  (["cashu", "lightning", "arkade", "bark", "spark", "bitcoin", "fedimint", "usdt"] as const).flatMap((type) => (["mainnet", "testnet"] as const).map((network) => {
    const base: WalletOffer = (type === "spark" || type === "fedimint") && network === "mainnet"
      ? { type, network, available: false, reason: `${type} on Mainnet is not available yet: it has only been tried on test networks.` }
      : type === "fedimint" ? { type, network, available: true, needs: "invite" }
      : type === "lightning" ? { type, network, available: true, needs: "provider", providers: offered("lightning", network).filter((d) => d.id !== "cashu-mint") }
      : type === "bitcoin" ? (network === "testnet" ? { type, network, available: true, needs: "provider", providers: offered("onchain", network) } : { type, network, available: false, reason: "No on-chain wallet runs on Mainnet here yet" })
      : { type, network, available: true };
    return { ...base, ...patch[`${type}:${network}`] };
  }));
const empty = (): WalletView => walletView({ offers: offers() });

describe("a profile with no wallet yet", () => {
  it("is not a dead end: it says how to start, with New in the header and no network switch", async () => {
    const { engine } = renderApp(<Wallet />);
    engine.update({ wallet: empty() });
    expect(await screen.findByTestId("wallet-first")).toHaveTextContent("Create your first wallet");
    expect(screen.getByTestId("wallet-add")).toHaveTextContent("New");
    expect(screen.queryByTestId("wallet-mode")).not.toBeInTheDocument();
    expect(screen.queryByTestId("testnet-notice")).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "Wallet integrations" })).not.toBeInTheDocument();
  });

  it("makes Cashu and USDT on the network chosen, one after the other, and then shows their cards", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: empty() });
    engine.on("walletCreate", (params) => {
      const wallets = [...(engine.state.wallet.wallets ?? []), made(params.type, params.network)];
      engine.update({ wallet: walletView({ mints: [mint(TEST_MINT, 0)], usdt: wallets.some((w) => w.type === "usdt") ? usdtReady({ balance: "0" }) : undefined, offers: offers() }) });
      return made(params.type, params.network);
    });
    await user.click(await screen.findByTestId("wallet-first-testnet"));
    expect(engine.callsTo("walletCreate")).toEqual([{ type: "cashu", network: "testnet" }, { type: "usdt", network: "testnet" }]);
    const deck = await screen.findByRole("tablist", { name: "Testnet wallets" });
    expect(within(deck).getByTestId("wallet-card-cashu-testnet")).toHaveTextContent("Testnet");
    expect(within(deck).getByTestId("wallet-card-usdt-testnet")).toBeInTheDocument();
    expect(screen.queryByTestId("wallet-first")).not.toBeInTheDocument();
  });

  it("says which one failed, keeps what was made, and tries only that one again", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: empty() });
    let usdtDown = true;
    engine.on("walletCreate", (params) => {
      if (params.type === "usdt" && usdtDown) throw new Error("Could not create the Mainnet USDT wallet: RPC unavailable. Nothing was saved; try again.");
      return made(params.type, params.network);
    });
    await user.click(await screen.findByTestId("wallet-first-mainnet"));
    expect(await screen.findByTestId("wallet-first-error-usdt")).toHaveTextContent("RPC unavailable. Nothing was saved; try again.");
    expect(screen.queryByTestId("wallet-first-error-cashu")).not.toBeInTheDocument();
    usdtDown = false;
    await user.click(screen.getByTestId("wallet-first-retry-usdt"));
    expect(engine.callsTo("walletCreate").slice(-1)).toEqual([{ type: "usdt", network: "mainnet" }]);
    expect(screen.queryByTestId("wallet-first-error-usdt")).not.toBeInTheDocument();
  });
});

describe("New, in the header", () => {
  it("offers every kind on the network chosen, each saying what clicking it does, and why one is not there yet", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: walletView({ mints: [mint(TEST_MINT, 5)], balance: 5, offers: offers({ "cashu:testnet": { exists: true } }) }) });
    await user.click(await screen.findByTestId("wallet-add"));
    const dialog = screen.getByTestId("new-wallet");
    // The network is the first choice, in words and ticked: Test money is where it opens (the chosen card's network).
    expect(within(dialog).getByTestId("new-wallet-network")).toHaveAttribute("data-network", "testnet");
    expect(within(dialog).getByTestId("new-wallet-network-testnet")).toHaveAttribute("aria-checked", "true");
    expect(within(dialog).getByTestId("new-wallet-network-testnet")).toHaveTextContent("Test money");
    expect(within(dialog).getByTestId("new-wallet-network-mainnet")).toHaveTextContent("Real money");
    expect(within(dialog).getByRole("heading", { name: "Kinds of wallet on Testnet" })).toBeInTheDocument();
    // Each kind is a button whose action says what happens: made, connected, joined, or there already.
    expect(within(dialog).getByTestId("new-wallet-type-cashu-status")).toHaveTextContent("Added");
    expect(within(dialog).getByTestId("new-wallet-type-cashu")).toHaveAttribute("aria-disabled", "true");
    expect(within(dialog).getByTestId("new-wallet-type-cashu-status").querySelector("svg")).not.toBeNull();
    expect(within(dialog).getByTestId("new-wallet-type-arkade-status")).toHaveTextContent("Create");
    expect(within(dialog).getByTestId("new-wallet-type-fedimint-status")).toHaveTextContent("Join with invite…");
    expect(within(dialog).getByTestId("new-wallet-type-lightning-status")).toHaveTextContent("Connect…");
    await user.click(within(dialog).getByTestId("new-wallet-network-mainnet"));
    expect(within(dialog).getByTestId("new-wallet-network")).toHaveAttribute("data-network", "mainnet");
    expect(within(dialog).getByTestId("new-wallet-type-spark")).toHaveAttribute("aria-disabled", "true");
    expect(within(dialog).getByTestId("new-wallet-type-spark")).toHaveTextContent("spark on Mainnet is not available yet");
    expect(within(dialog).getByTestId("new-wallet-type-spark-status")).toHaveTextContent("Not yet");
    expect(within(dialog).getByTestId("new-wallet-type-cashu-status")).toHaveTextContent("Create");
    // Bark on Bitcoin, one click, with its server's terms named.
    expect(within(dialog).getByTestId("new-wallet-type-bark-status")).toHaveTextContent("Create");
    expect(within(dialog).getByTestId("new-wallet-type-bark")).toHaveTextContent("Second's Ark on Bitcoin. Second's terms apply; start small.");
    // Why not, in one short line; the whole reason on hover.
    expect(within(dialog).getByTestId("new-wallet-type-spark")).toHaveAttribute("title", expect.stringMatching(/not available yet: it has only been tried on test networks/));
    // A kind that is not there yet makes nothing when clicked.
    engine.on("walletCreate", () => made("spark", "mainnet"));
    await user.click(within(dialog).getByTestId("new-wallet-type-spark"));
    expect(engine.callsTo("walletCreate")).toEqual([]);
  });

  it("makes a kind that needs nothing in one click, and brings its card up", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: walletView({ mints: [mint(REAL_MINT, 10)], balance: 10, offers: offers() }) });
    engine.on("walletCreate", (params) => {
      engine.update({ wallet: walletView({ mints: [mint(REAL_MINT, 10)], balance: 10, ark: arkReady(), offers: offers() }) });
      return made(params.type, params.network);
    });
    await user.click(await screen.findByTestId("wallet-add"));
    // It opens on the chosen card's network (Mainnet Cashu here): the network is one click away.
    expect(screen.getByTestId("new-wallet-network")).toHaveAttribute("data-network", "mainnet");
    await user.click(screen.getByTestId("new-wallet-network-testnet"));
    await user.click(screen.getByTestId("new-wallet-type-arkade"));
    expect(engine.callsTo("walletCreate")).toEqual([{ type: "arkade", network: "testnet" }]);
    // Ready, then the dialog closes and the card is in its network's deck.
    await waitFor(() => expect(screen.queryByTestId("new-wallet")).not.toBeInTheDocument());
    expect(await screen.findByTestId("wallet-card-arkade-testnet")).toHaveAttribute("aria-selected", "true");
    // Made on Testnet, it brings the Testnet tab with it.
    expect(screen.getByTestId("wallet-network-testnet")).toHaveAttribute("aria-selected", "true");
    expect(within(screen.getByRole("tablist", { name: "Testnet wallets" })).getByTestId("wallet-card-arkade-testnet")).toBeInTheDocument();
    expect(await screen.findByTestId("ark-wallet", {}, { timeout: 5000 })).toBeInTheDocument();
  });

  it("a Mainnet Bark wallet, once made, offers its backup before its card is dealt; Done shows the card", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: walletView({ mints: [mint(REAL_MINT, 10)], balance: 10, offers: offers() }) });
    engine.on("walletCreate", (params) => {
      engine.update({ wallet: walletView({ mints: [mint(REAL_MINT, 10)], balance: 10, bark: barkReady({ network: "bitcoin", provider: "https://ark.second.tech" }), offers: offers({ "bark:mainnet": { exists: true } }) }) });
      return made(params.type, params.network);
    });
    engine.on("barkBackup", () => ({ mnemonic: "one two three four five six seven eight nine ten eleven twelve", config: { network: "bitcoin", provider: "https://ark.second.tech", explorer: "https://mempool.second.tech/api", serverKey: "03", walletId: "w" } }));
    await user.click(await screen.findByTestId("wallet-add"));
    await user.click(screen.getByTestId("new-wallet-type-bark"));
    expect(engine.callsTo("walletCreate")).toEqual([{ type: "bark", network: "mainnet" }]);
    const backup = await screen.findByTestId("new-wallet-backup");
    expect(backup).toHaveTextContent("It holds real bitcoin, and its recovery phrase lives only on this device.");
    expect(within(backup).getByTestId("new-wallet-terms")).toHaveAttribute("href", "https://second.tech/terms");
    // It stays open until the person is done: no card is dealt meanwhile, and the phrase shows only on Show.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(screen.getByTestId("new-wallet")).toBeInTheDocument();
    expect(within(backup).queryByTestId("bark-recovery")).not.toBeInTheDocument();
    await user.click(within(backup).getByRole("button", { name: "Show" }));
    expect(await within(backup).findByTestId("bark-recovery")).toHaveTextContent(/^one two three/);
    expect(engine.callsTo("barkBackup")).toEqual([{ network: "mainnet" }]);
    await user.click(within(backup).getByTestId("new-wallet-backup-done"));
    await waitFor(() => expect(screen.queryByTestId("new-wallet")).not.toBeInTheDocument());
    expect(await screen.findByTestId("wallet-card-bark-mainnet")).toHaveAttribute("aria-selected", "true");
  });

  it("a Testnet Bark wallet closes on Ready as the others do: no backup step for test coins", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: walletView({ mints: [mint(TEST_MINT, 5)], balance: 5, offers: offers({ "cashu:testnet": { exists: true } }) }) });
    engine.on("walletCreate", (params) => made(params.type, params.network));
    await user.click(await screen.findByTestId("wallet-add"));
    await user.click(screen.getByTestId("new-wallet-type-bark"));
    await waitFor(() => expect(screen.queryByTestId("new-wallet")).not.toBeInTheDocument());
    expect(screen.queryByTestId("new-wallet-backup")).not.toBeInTheDocument();
  });

  it("a creation that fails says why once, leaves the dialog open, and tries again on request", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: walletView({ mints: [mint(REAL_MINT, 10)], balance: 10, offers: offers() }) });
    let down = true;
    engine.on("walletCreate", (params) => {
      if (down) throw new Error("Could not create the Testnet Ark wallet: It did not answer in time. Nothing was saved; try again.");
      return made(params.type, params.network);
    });
    await user.click(await screen.findByTestId("wallet-add"));
    await user.click(screen.getByTestId("new-wallet-network-testnet"));
    await user.click(screen.getByTestId("new-wallet-type-arkade"));
    expect(await screen.findByTestId("new-wallet-error")).toHaveTextContent("It did not answer in time. Nothing was saved; try again.");
    down = false;
    await user.click(screen.getByTestId("new-wallet-retry"));
    expect(engine.callsTo("walletCreate")).toHaveLength(2);
    await waitFor(() => expect(screen.queryByTestId("new-wallet")).not.toBeInTheDocument());
  });

  it("Fedimint asks for its invite only, and Lightning for its source's form only", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: walletView({ mints: [mint(REAL_MINT, 10)], balance: 10, offers: offers() }) });
    engine.on("walletCreate", (params) => made(params.type, params.network));
    await user.click(await screen.findByTestId("wallet-add"));
    await user.click(screen.getByTestId("new-wallet-network-testnet"));
    await user.click(screen.getByTestId("new-wallet-type-fedimint"));
    expect(engine.callsTo("walletCreate")).toEqual([]);
    await user.type(screen.getByTestId("new-wallet-invite"), "fed11qqqq");
    await user.click(screen.getByTestId("new-wallet-create"));
    expect(engine.callsTo("walletCreate")).toEqual([{ type: "fedimint", network: "testnet", invite: "fed11qqqq" }]);
    await waitFor(() => expect(screen.queryByTestId("new-wallet")).not.toBeInTheDocument());

    await user.click(await screen.findByTestId("wallet-add"));
    await user.click(screen.getByTestId("new-wallet-network-testnet"));
    await user.click(screen.getByTestId("new-wallet-type-lightning"));
    const form = await screen.findByTestId("new-wallet-provider");
    await choose(user, within(form).getByRole("combobox", { name: "Source" }), "nwc");
    expect(await within(form).findByTestId("provider-form-nwc")).toBeInTheDocument();
    expect(engine.callsTo("walletCreate")).toHaveLength(1);
  });
});

describe("the picker, while a wallet is made", () => {
  /** A creation the test finishes itself: the dialog shows each state in turn. */
  function slow(engine: ReturnType<typeof renderApp>["engine"]) {
    let settle!: (outcome: Error | WalletInstanceView) => void;
    engine.on("walletCreate", () => new Promise<WalletInstanceView>((resolve, reject) => { settle = (o) => o instanceof Error ? reject(o) : resolve(o); }));
    return (outcome: Error | WalletInstanceView) => act(async () => { settle(outcome); });
  }

  it("idle, then connecting on the card chosen with its steps, then Ready, then the card in its deck", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: walletView({ mints: [mint(TEST_MINT, 5)], balance: 5, offers: offers({ "cashu:testnet": { exists: true } }) }) });
    const finish = slow(engine);
    await user.click(await screen.findByTestId("wallet-add"));
    const ark = screen.getByTestId("new-wallet-type-arkade");
    expect(ark).toHaveAttribute("data-state", "on");
    expect(screen.queryByTestId("new-wallet-progress")).not.toBeInTheDocument();

    await user.click(ark);
    expect(ark).toHaveAttribute("data-state", "busy");
    expect(ark).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("new-wallet-type-arkade-status")).toHaveTextContent("Creating…");
    // Nothing else can start meanwhile, and the network cannot change under it.
    expect(screen.getByTestId("new-wallet-type-usdt")).toBeDisabled();
    expect(screen.getByTestId("new-wallet-network-mainnet")).toBeDisabled();
    const progress = screen.getByTestId("new-wallet-progress");
    expect(progress).toHaveTextContent("Nothing is saved until its server answers");
    expect(within(progress).getAllByTestId("new-wallet-step").map((s) => [s.textContent, s.dataset.state])).toEqual([["Creating keys…", "active"], ["Reaching the Ark server", "todo"]]);
    await waitFor(() => expect(within(progress).getAllByTestId("new-wallet-step").map((s) => s.dataset.state)).toEqual(["done", "active"]));
    // Escape does not close it while the wallet is being made.
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("new-wallet")).toBeInTheDocument();

    engine.update({ wallet: walletView({ mints: [mint(TEST_MINT, 5)], balance: 5, ark: arkReady(), offers: offers({ "cashu:testnet": { exists: true }, "arkade:testnet": { exists: true } }) }) });
    await finish(made("arkade", "testnet"));
    expect(screen.getByTestId("new-wallet-ready")).toHaveAttribute("data-state", "done");
    expect(screen.getByTestId("new-wallet-type-arkade-status")).toHaveTextContent("Ready");
    expect(screen.getByTestId("new-wallet-progress")).toHaveTextContent("Your Testnet Ark wallet is ready.");
    await waitFor(() => expect(screen.queryByTestId("new-wallet")).not.toBeInTheDocument());
    expect(within(screen.getByRole("tablist", { name: "Testnet wallets" })).getByTestId("wallet-card-arkade-testnet")).toHaveAttribute("aria-selected", "true");
  });

  it("a failure shows once, on the card and below it, with Try again; nothing is left chosen or half made", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: walletView({ mints: [mint(TEST_MINT, 5)], balance: 5, offers: offers() }) });
    const finish = slow(engine);
    await user.click(await screen.findByTestId("wallet-add"));
    await user.click(screen.getByTestId("new-wallet-type-usdt"));
    await finish(new Error("Could not create the Testnet USDT wallet: RPC unavailable. Nothing was saved; try again."));
    expect(screen.getByTestId("new-wallet-type-usdt")).toHaveAttribute("data-state", "error");
    expect(screen.getByTestId("new-wallet-type-usdt-status")).toHaveTextContent("Try again");
    expect(screen.getAllByTestId("new-wallet-error")).toHaveLength(1);
    expect(screen.getByTestId("new-wallet-error")).toHaveTextContent("RPC unavailable. Nothing was saved; try again.");
    expect(screen.queryByTestId("new-wallet-progress")).not.toBeInTheDocument();
    // The others can be chosen again, and the network changed.
    expect(screen.getByTestId("new-wallet-type-arkade")).toBeEnabled();
    expect(screen.getByTestId("new-wallet-network-mainnet")).toBeEnabled();
    // Try again on the card itself.
    const again = slow(engine);
    await user.click(screen.getByTestId("new-wallet-type-usdt"));
    expect(screen.getByTestId("new-wallet-type-usdt")).toHaveAttribute("data-state", "busy");
    expect(screen.queryByTestId("new-wallet-error")).not.toBeInTheDocument();
    await again(made("usdt", "testnet"));
    expect(engine.callsTo("walletCreate")).toEqual([{ type: "usdt", network: "testnet" }, { type: "usdt", network: "testnet" }]);
  });

  it("a kind that needs one thing asks for it on its own step, with a way back to every kind", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: walletView({ mints: [mint(TEST_MINT, 5)], balance: 5, offers: offers() }) });
    await user.click(await screen.findByTestId("wallet-add"));
    await user.click(screen.getByTestId("new-wallet-type-fedimint"));
    expect(screen.getByTestId("new-wallet-step")).toHaveTextContent("Testnet Fedimint");
    expect(screen.queryByTestId("new-wallet-type-arkade")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("new-wallet-back"));
    expect(screen.getByTestId("new-wallet-type-arkade")).toBeInTheDocument();
    expect(engine.callsTo("walletCreate")).toEqual([]);
  });

  it("is a sheet on a phone", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: walletView({ mints: [mint(TEST_MINT, 5)], balance: 5, offers: offers() }) });
    await user.click(await screen.findByTestId("wallet-add"));
    expect(screen.getByTestId("new-wallet")).toHaveClass("sheet");
  });
});

describe("real money and test money, two wallets apart", () => {
  const both = () => walletView({ mints: [mint(REAL_MINT, 21), mint(TEST_MINT, 5)], balance: 26, offers: offers() });
  const tab = (network: "mainnet" | "testnet") => screen.getByRole("tab", { name: new RegExp(`^${network === "mainnet" ? "Real money, Mainnet" : "Test money, Testnet"}`) });

  it("two tabs, Mainnet | Testnet, each with its count and whose money in words; only the chosen network's deck shows", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: walletView({ mints: [mint(REAL_MINT, 21), mint(TEST_MINT, 5)], balance: 26, ark: arkReady(), offers: offers() }) });
    const tabs = await screen.findByRole("tablist", { name: "Networks" });
    expect(within(tabs).getAllByRole("tab").map((t) => t.dataset.testid)).toEqual(["wallet-network-mainnet", "wallet-network-testnet"]);
    expect(tab("mainnet")).toHaveAccessibleName("Real money, Mainnet, 2 wallets");
    expect(tab("testnet")).toHaveAccessibleName("Test money, Testnet, 3 wallets");
    expect(screen.getByTestId("wallet-network-mainnet")).toHaveTextContent("Real moneyMainnet · 2");
    expect(screen.getByTestId("wallet-network-mainnet-tag")).toHaveAttribute("data-network", "mainnet");
    expect(screen.getByTestId("wallet-network-testnet-tag")).toHaveTextContent("Test money");
    // Real money is where it opens, when there is some: its tab chosen, its panel labelled by it, its deck alone.
    expect(tab("mainnet")).toHaveAttribute("aria-selected", "true");
    expect(tab("testnet")).toHaveAttribute("aria-selected", "false");
    const panel = screen.getByTestId("wallet-network-panel");
    expect(panel).toHaveAttribute("role", "tabpanel");
    expect(panel).toHaveAttribute("aria-labelledby", "wallet-network-tab-mainnet");
    expect(tab("mainnet")).toHaveAttribute("aria-controls", "wallet-network-panel");
    expect(screen.getByTestId("wallet-network-about")).toHaveTextContent("Money you own: spend it with care.");
    const mainnetDeck = within(panel).getByRole("tablist", { name: "Mainnet wallets" });
    expect(within(mainnetDeck).getAllByRole("tab").map((t) => t.dataset.testid)).toEqual(["wallet-card-cashu-mainnet", "wallet-card-lightning-mainnet"]);
    expect(screen.queryByRole("tablist", { name: "Testnet wallets" })).not.toBeInTheDocument();
    const mainnet = within(mainnetDeck).getByTestId("wallet-card-cashu-mainnet");
    expect(mainnet).toHaveAttribute("aria-selected", "true");
    expect(within(mainnet).queryByTestId("wallet-card-network")).not.toBeInTheDocument();
    expect(mainnet).not.toHaveTextContent("test sats");
    expect(screen.getByTestId("wallet-panel-network")).toHaveTextContent("Real money");

    // Testnet: its deck in place of Mainnet's, its first card's panel below, the card saying Testnet.
    await user.click(tab("testnet"));
    expect(tab("testnet")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("wallet-network-panel")).toHaveAttribute("aria-labelledby", "wallet-network-tab-testnet");
    expect(screen.getByTestId("wallet-network-about")).toHaveTextContent("Test coins, worth nothing: for trying things out.");
    expect(screen.queryByRole("tablist", { name: "Mainnet wallets" })).not.toBeInTheDocument();
    const testnetDeck = screen.getByRole("tablist", { name: "Testnet wallets" });
    expect(within(testnetDeck).getAllByRole("tab").map((t) => t.dataset.testid)).toEqual(["wallet-card-cashu-testnet", "wallet-card-lightning-testnet", "wallet-card-arkade-testnet"]);
    const testnet = within(testnetDeck).getByTestId("wallet-card-cashu-testnet");
    expect(testnet).toHaveAttribute("aria-selected", "true");
    expect(within(testnet).getByTestId("wallet-card-network")).toHaveTextContent("Testnet");
    expect(testnet).toHaveTextContent("test sats");
    expect(screen.getByTestId("wallet-panel")).toHaveAttribute("aria-labelledby", "wallet-tab-cashu:testnet");
    expect(screen.getByTestId("wallet-panel-network")).toHaveTextContent("Test money");
  });

  it("opens on Testnet when Mainnet has no wallet; the empty tab says so, with New on its network", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: walletView({ mints: [mint(TEST_MINT, 5)], balance: 5, offers: offers() }) });
    expect(await screen.findByRole("tablist", { name: "Testnet wallets" })).toBeInTheDocument();
    expect(tab("testnet")).toHaveAttribute("aria-selected", "true");
    expect(tab("mainnet")).toHaveAccessibleName("Real money, Mainnet, 0 wallets");
    await user.click(tab("mainnet"));
    const empty = screen.getByTestId("wallet-network-mainnet-empty");
    expect(empty).toHaveTextContent("No Mainnet wallets yet.");
    expect(screen.queryByTestId("wallet-panel")).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "Testnet wallets" })).not.toBeInTheDocument();
    await user.click(within(empty).getByTestId("wallet-network-mainnet-new"));
    expect(screen.getByTestId("new-wallet-network")).toHaveAttribute("data-network", "mainnet");
  });

  it("New in the header opens the picker on the tab's network, and the picker can still switch", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: both() });
    await user.click(await screen.findByTestId("wallet-add"));
    expect(screen.getByTestId("new-wallet-network")).toHaveAttribute("data-network", "mainnet");
    await user.click(screen.getByTestId("new-wallet-network-testnet"));
    expect(screen.getByTestId("new-wallet-network")).toHaveAttribute("data-network", "testnet");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("new-wallet")).not.toBeInTheDocument());
    // The picker's choice is not the page's: the tab is still Mainnet.
    expect(tab("mainnet")).toHaveAttribute("aria-selected", "true");
    await user.click(tab("testnet"));
    await user.click(screen.getByTestId("wallet-add"));
    expect(screen.getByTestId("new-wallet-network")).toHaveAttribute("data-network", "testnet");
    expect(screen.getByTestId("new-wallet-network-testnet")).toHaveAttribute("aria-checked", "true");
  });

  it("remembers the tab on this device, and not one whose network has no wallet in this profile", async () => {
    const first = renderApp(<Wallet />);
    first.engine.update({ wallet: both() });
    await first.user.click(await screen.findByTestId("wallet-network-testnet"));
    expect(localStorage.getItem(NETWORK_KEY)).toBe("testnet");
    first.unmount();
    const again = renderApp(<Wallet />);
    again.engine.update({ wallet: both() });
    expect(await screen.findByRole("tablist", { name: "Testnet wallets" })).toBeInTheDocument();
    expect(tab("testnet")).toHaveAttribute("aria-selected", "true");
    again.unmount();
    // Another profile on this device, with real money only: Mainnet, where its wallets are.
    const other = renderApp(<Wallet />);
    other.engine.update({ wallet: walletView({ mints: [mint(REAL_MINT, 21)], offers: offers() }) });
    expect(await screen.findByRole("tablist", { name: "Mainnet wallets" })).toBeInTheDocument();
    expect(tab("mainnet")).toHaveAttribute("aria-selected", "true");
  });

  it("the page still opens where storage cannot be read or written", async () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    try {
      const { user, engine } = renderApp(<Wallet />);
      engine.update({ wallet: both() });
      expect(await screen.findByRole("tablist", { name: "Mainnet wallets" })).toBeInTheDocument();
      await user.click(tab("testnet"));
      expect(screen.getByRole("tablist", { name: "Testnet wallets" })).toBeInTheDocument();
    } finally { get.mockRestore(); set.mockRestore(); }
  });

  it("a proper tablist: the arrows, Home and End move between the tabs and take the focus with them", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: both() });
    await screen.findByRole("tablist", { name: "Networks" });
    expect(tab("mainnet")).toHaveAttribute("tabindex", "0");
    expect(tab("testnet")).toHaveAttribute("tabindex", "-1");
    tab("mainnet").focus();
    await user.keyboard("{ArrowRight}");
    expect(tab("testnet")).toHaveFocus();
    expect(tab("testnet")).toHaveAttribute("aria-selected", "true");
    expect(tab("testnet")).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tablist", { name: "Testnet wallets" })).toBeInTheDocument();
    await user.keyboard("{ArrowRight}");
    expect(tab("mainnet")).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(tab("testnet")).toHaveFocus();
    await user.keyboard("{Home}");
    expect(tab("mainnet")).toHaveFocus();
    expect(tab("mainnet")).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{End}");
    expect(tab("testnet")).toHaveFocus();
    // Tab leaves the tablist for the network's deck, on its chosen card.
    await user.tab();
    expect(screen.getByTestId("wallet-card-cashu-testnet")).toHaveFocus();
  });

  it("each tab keeps the card it showed last", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: both() });
    await user.click(await screen.findByTestId("wallet-network-testnet"));
    await user.click(screen.getByTestId("wallet-card-lightning-testnet"));
    expect(screen.getByTestId("wallet-panel")).toHaveAttribute("aria-labelledby", "wallet-tab-lightning:testnet");
    await user.click(tab("mainnet"));
    expect(screen.getByTestId("wallet-panel")).toHaveAttribute("aria-labelledby", "wallet-tab-cashu:mainnet");
    await user.click(screen.getByTestId("wallet-card-lightning-mainnet"));
    await user.click(tab("testnet"));
    expect(screen.getByTestId("wallet-card-lightning-testnet")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("wallet-panel")).toHaveAttribute("aria-labelledby", "wallet-tab-lightning:testnet");
    await user.click(tab("mainnet"));
    expect(screen.getByTestId("wallet-card-lightning-mainnet")).toHaveAttribute("aria-selected", "true");
  });

  it("switching slides the other deck in, once; not as the page opens", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: both() });
    await screen.findByRole("tablist", { name: "Mainnet wallets" });
    const view = () => screen.getByRole("tablist", { name: /wallets$/ }).closest(".wallet-network-view")!;
    expect(view()).not.toHaveAttribute("data-swap");
    await user.click(tab("testnet"));
    expect(view()).toHaveAttribute("data-swap", "next");
    fireEvent.animationEnd(view());
    expect(view()).not.toHaveAttribute("data-swap");
    await user.click(tab("mainnet"));
    expect(view()).toHaveAttribute("data-swap", "prev");
  });

  it("a card's panel acts on its own network's wallet", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: both() });
    engine.on("walletReceiveLightning", () => ({ quote: "q", invoice: "lnbc210n1test", expiresAt: null, source: "cashu-mint" }));
    await user.click(await screen.findByTestId("wallet-network-testnet"));
    await user.click(await screen.findByTestId("wallet-card-cashu-testnet"));
    await user.click(await screen.findByTestId("wallet-receive"));
    await user.type(screen.getByTestId("wallet-receive-amount"), "21");
    await user.click(screen.getByTestId("wallet-create-invoice"));
    expect(engine.callsTo("walletReceiveLightning")).toEqual([{ amount: 21, via: "cashu", network: "testnet" }]);
  });
});

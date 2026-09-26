import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WalletInstanceView, WalletOffer, WalletView } from "@ghostly/browser/shared/types";
import { Wallet } from "../../pages/Wallet";
import { walletView } from "../fakeEngine";
import { renderApp } from "../render";
import { arkReady, mint, REAL_MINT, TEST_MINT, usdtReady } from "../payments/fixtures";
import { offered } from "./descriptors";
import { choose } from "../select";

// covers: wallet.instances.create, wallet.instances.networks, wallet.instances.sections, wallet.deck

const made = (type: WalletInstanceView["type"], network: WalletInstanceView["network"]): WalletInstanceView => ({ id: `${type}:${network}`, type, network, config: {} });
/** What New offers when nothing is made yet: every kind, Bark, Spark and Fedimint Testnet only. */
const offers = (patch: Partial<Record<string, Partial<WalletOffer>>> = {}): WalletOffer[] =>
  (["cashu", "lightning", "arkade", "bark", "spark", "bitcoin", "fedimint", "usdt"] as const).flatMap((type) => (["mainnet", "testnet"] as const).map((network) => {
    const base: WalletOffer = (type === "bark" || type === "spark" || type === "fedimint") && network === "mainnet"
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
    expect(within(dialog).getByTestId("new-wallet-type-bark")).toHaveAttribute("aria-disabled", "true");
    expect(within(dialog).getByTestId("new-wallet-type-bark")).toHaveTextContent("bark on Mainnet is not available yet");
    expect(within(dialog).getByTestId("new-wallet-type-bark-status")).toHaveTextContent("Not yet");
    expect(within(dialog).getByTestId("new-wallet-type-cashu-status")).toHaveTextContent("Create");
    // Why not, in one short line; the whole reason on hover.
    expect(within(dialog).getByTestId("new-wallet-type-bark")).toHaveAttribute("title", expect.stringMatching(/not available yet: it has only been tried on test networks/));
    // A kind that is not there yet makes nothing when clicked.
    engine.on("walletCreate", () => made("bark", "mainnet"));
    await user.click(within(dialog).getByTestId("new-wallet-type-bark"));
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
    expect(within(screen.getByTestId("wallet-section-testnet")).getByTestId("wallet-card-arkade-testnet")).toBeInTheDocument();
    expect(await screen.findByTestId("ark-wallet", {}, { timeout: 5000 })).toBeInTheDocument();
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
    expect(within(screen.getByTestId("wallet-section-testnet")).getByTestId("wallet-card-arkade-testnet")).toHaveAttribute("aria-selected", "true");
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

describe("real money and test money, apart", () => {
  it("two sections, Real money on Mainnet and Test money on Testnet, each its own deck; only the test card says Testnet", async () => {
    const { engine } = renderApp(<Wallet />);
    engine.update({ wallet: walletView({ mints: [mint(REAL_MINT, 21), mint(TEST_MINT, 5)], balance: 26, offers: offers() }) });
    const real = await screen.findByTestId("wallet-section-mainnet"), test = screen.getByTestId("wallet-section-testnet");
    expect(within(real).getByRole("heading")).toHaveTextContent("Real money · Mainnet");
    expect(within(test).getByRole("heading")).toHaveTextContent("Test money · Testnet");
    expect(within(real).getByTestId("wallet-section-mainnet-tag")).toHaveAttribute("data-network", "mainnet");
    const mainnetDeck = within(real).getByRole("tablist", { name: "Mainnet wallets" }), testnetDeck = within(test).getByRole("tablist", { name: "Testnet wallets" });
    expect(within(mainnetDeck).getAllByRole("tab").map((t) => t.dataset.testid)).toEqual(["wallet-card-cashu-mainnet", "wallet-card-lightning-mainnet"]);
    expect(within(testnetDeck).getAllByRole("tab").map((t) => t.dataset.testid)).toEqual(["wallet-card-cashu-testnet", "wallet-card-lightning-testnet"]);
    const mainnet = within(mainnetDeck).getByTestId("wallet-card-cashu-mainnet"), testnet = within(testnetDeck).getByTestId("wallet-card-cashu-testnet");
    expect(within(testnet).getByTestId("wallet-card-network")).toHaveTextContent("Testnet");
    expect(within(mainnet).queryByTestId("wallet-card-network")).not.toBeInTheDocument();
    expect(testnet).toHaveTextContent("test sats");
    expect(mainnet).not.toHaveTextContent("test sats");
    // One card is the panel's: its deck is live, the other rests with no card selected.
    expect(mainnet).toHaveAttribute("aria-selected", "true");
    expect(testnetDeck.closest(".deck")).toHaveAttribute("data-resting", "true");
    expect(within(testnetDeck).getAllByRole("tab").every((t) => t.getAttribute("aria-selected") === "false")).toBe(true);
    expect(screen.getByTestId("wallet-panel-network")).toHaveTextContent("Real money");
  });

  it("an empty network says so, and its New opens the picker on that network", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: walletView({ mints: [mint(TEST_MINT, 5)], balance: 5, offers: offers() }) });
    const empty = await screen.findByTestId("wallet-section-mainnet-empty");
    expect(empty).toHaveTextContent("No Mainnet wallets yet.");
    expect(screen.queryByTestId("wallet-section-testnet-empty")).not.toBeInTheDocument();
    await user.click(within(empty).getByTestId("wallet-section-mainnet-new"));
    expect(screen.getByTestId("new-wallet-network")).toHaveAttribute("data-network", "mainnet");
  });

  it("clicking the resting deck hands it the panel; the other deck keeps its card on top", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: walletView({ mints: [mint(REAL_MINT, 21), mint(TEST_MINT, 5)], balance: 26, offers: offers() }) });
    await user.click(await screen.findByTestId("wallet-card-lightning-testnet"));
    expect(screen.getByTestId("wallet-card-lightning-testnet")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "wallet-tab-lightning:testnet");
    expect(screen.getByTestId("wallet-section-mainnet").querySelector(".deck")).toHaveAttribute("data-resting", "true");
    await user.click(screen.getByTestId("wallet-card-cashu-mainnet"));
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "wallet-tab-cashu:mainnet");
    // Lightning stays the Testnet deck's top card, and a click on it brings it back.
    expect(screen.getByTestId("wallet-card-lightning-testnet")).toHaveAttribute("tabindex", "0");
    await user.click(screen.getByTestId("wallet-card-lightning-testnet"));
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "wallet-tab-lightning:testnet");
  });

  it("a card's panel acts on its own network's wallet", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: walletView({ mints: [mint(REAL_MINT, 21), mint(TEST_MINT, 5)], balance: 26, offers: offers() }) });
    engine.on("walletReceiveLightning", () => ({ quote: "q", invoice: "lnbc210n1test", expiresAt: null, source: "cashu-mint" }));
    await user.click(await screen.findByTestId("wallet-card-cashu-testnet"));
    await user.click(await screen.findByTestId("wallet-receive"));
    await user.type(screen.getByTestId("wallet-receive-amount"), "21");
    await user.click(screen.getByTestId("wallet-create-invoice"));
    expect(engine.callsTo("walletReceiveLightning")).toEqual([{ amount: 21, via: "cashu", network: "testnet" }]);
  });
});

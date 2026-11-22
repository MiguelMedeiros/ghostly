import { Profiler } from "react";
import { act, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
import { SEPOLIA_TEST_USDT, type WalletNetwork } from "@ghostly/core";
import type { MintView, NetworkWalletsView, PaymentView, WalletAwaitingView, WalletInstanceView, WalletOffer, WalletSetupView, WalletView } from "@ghostly/browser/shared/types";
import type { BackupReminders } from "@ghostly/browser/shared/backupReminder";
import type { LightningCardView } from "@ghostly/browser/engine/paymentAdapters/providers/lightningCards";
import { Wallet } from "../../pages/Wallet";
import { AccountBar } from "../../components/AccountBar";
import { MobileTabBar } from "../../components/MobileTabBar";
import { ProfileBackups } from "../../components/ProfileBackups";
import { PaymentBubble } from "../../components/PaymentBubble";
import { PaymentComposer } from "../../components/PaymentComposer";
import { faucetFor } from "../../components/wallet/TestCoins";
import { networkState } from "../../components/walletCardData";
import { rememberRail } from "../../lib/chatPayments";
import type { Language } from "../../lib/settings";
import { fakeEngine, linkView, paymentView, walletView, type StatePatch } from "../fakeEngine";
import { renderApp } from "../render";
import { arkReady, barkReady, bitcoinSource, everyWallet, lightningSource, liveRegtestInvoice, mint, REAL_MINT, reviewContext, sparkReady, TEST_MINT, usdtReady } from "../payments/fixtures";
import { LANGUAGES, SECTIONS, lookup } from "../i18n/locales";
import { offered } from "./descriptors";
import { choose } from "../select";

// covers: wallet.balance.total
describe("the totals over the deck", () => {
  /**
   * The Wallets page's totals over each tab's deck: Bitcoin (every Bitcoin card of the tab) and USDT, each a button that
   * opens where it comes from, one row per card with an honest note. The tab chooses the network summed.
   */

  beforeEach(() => { document.documentElement.dataset.reduceMotion = "true"; });

  /** Mainnet: Cashu (and Lightning through its mints). Testnet: Ark, Spark (unread), on-chain with unconfirmed sats, USDT. */
  const wallet = (patch: Partial<WalletView> = {}) => walletView({
    mints: [mint(REAL_MINT, 1_000), mint(TEST_MINT, 0)], balance: 1_000,
    ark: arkReady({ read: true, balance: 5_000 }),
    spark: sparkReady(),
    bitcoin: bitcoinSource({ mode: "testnet", network: "regtest", read: true, balance: 170_000, unconfirmed: 40_000 }),
    usdt: usdtReady({ read: true, balance: "12500000" }),
    ...patch,
  });

  async function openOn(network: "mainnet" | "testnet", patch?: Partial<WalletView>) {
    const view = renderApp(<Wallet />);
    view.engine.update({ wallet: wallet(patch) });
    const tab = await screen.findByTestId(`wallet-network-${network}`);
    if (tab.getAttribute("aria-selected") !== "true") await view.user.click(tab);
    return view;
  }

  const row = (id: string) => screen.getByTestId(`wallet-total-row-${id}`);

  it("shows the tab's Bitcoin total and its USDT, and says how many cards are not in it", async () => {
    await openOn("testnet");
    const totals = screen.getByTestId("wallet-totals");
    expect(totals).toHaveAttribute("data-network", "testnet");
    expect(totals).toHaveAccessibleName("Balances");
    // 0 (Cashu) + 5,000 (Ark) + 210,000 (on-chain, 40,000 of it unconfirmed); Spark not read yet.
    expect(screen.getByTestId("wallet-total-bitcoin-amount")).toHaveTextContent("215,000test sats");
    expect(screen.getByTestId("wallet-total-bitcoin-uncounted")).toHaveTextContent("1 card not counted");
    expect(screen.getByTestId("wallet-total-usdt-amount")).toHaveTextContent("12.5TEST-USDT");
    expect(screen.queryByTestId("wallet-total-usdt-uncounted")).not.toBeInTheDocument();
    // Above the deck, the cards as they were.
    expect(totals.compareDocumentPosition(screen.getByRole("tablist", { name: "Testnet wallets" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("follows the network tab: Mainnet's total is Mainnet's cards only, and it has no USDT", async () => {
    const { user } = await openOn("testnet");
    await user.click(screen.getByTestId("wallet-network-mainnet"));
    expect(screen.getByTestId("wallet-totals")).toHaveAttribute("data-network", "mainnet");
    expect(screen.getByTestId("wallet-total-bitcoin-amount")).toHaveTextContent("1,000sats");
    expect(screen.queryByTestId("wallet-total-bitcoin-uncounted")).not.toBeInTheDocument();
    expect(screen.queryByTestId("wallet-total-usdt")).not.toBeInTheDocument();
  });

  it("opens where the Bitcoin total comes from: a row per card, its note, what is ready now; Escape closes it back to the total", async () => {
    const { user } = await openOn("testnet");
    const total = screen.getByTestId("wallet-total-bitcoin");
    expect(total).toHaveAttribute("aria-expanded", "false");
    await user.click(total);
    const breakdown = screen.getByRole("dialog", { name: /Bitcoin/ });
    expect(breakdown).toHaveAttribute("data-network", "testnet");
    expect(total).toHaveAttribute("aria-expanded", "true");
    expect(within(breakdown).getByTestId("wallet-total-network")).toHaveTextContent("Test money");
    expect(within(breakdown).getByTestId("wallet-total-sum-amount")).toHaveTextContent("215,000 test sats");
    expect(within(breakdown).getByTestId("wallet-total-ready-amount")).toHaveTextContent("175,000 test sats");
    // The deck's cards, in its order.
    expect(within(screen.getByTestId("wallet-total-rows")).getAllByTestId(/^wallet-total-row-/).map((r) => r.dataset.testid))
      .toEqual(["wallet-total-row-cashu-testnet", "wallet-total-row-lightning-testnet", "wallet-total-row-arkade-testnet", "wallet-total-row-spark-testnet", "wallet-total-row-bitcoin-testnet"]);
    expect(row("cashu-testnet")).toHaveTextContent("Ecash held by your mints");
    expect(row("lightning-testnet")).toHaveAttribute("data-state", "shared");
    expect(row("lightning-testnet")).toHaveTextContent("Same balance as Cashu, counted once");
    expect(row("bitcoin-testnet")).toHaveTextContent("40,000 test sats unconfirmed");
    expect(within(row("bitcoin-testnet")).getByTestId("wallet-total-line-amount")).toHaveTextContent("210,000 test sats");
    // Unknown is never a 0.
    expect(row("spark-testnet")).toHaveAttribute("data-state", "unknown");
    expect(row("spark-testnet")).toHaveTextContent("Couldn't read it now, not in the total");
    expect(within(row("spark-testnet")).getByTestId("wallet-total-line-amount")).toHaveTextContent("?");
    // The longer story behind the ⓘ.
    await user.click(within(screen.getByTestId("wallet-total-sum")).getByTestId("row-info"));
    expect(screen.getByTestId("row-info-text")).toHaveTextContent("Testnet is never added to Mainnet");

    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("wallet-total-breakdown")).not.toBeInTheDocument();
    expect(total).toHaveFocus();
  });

  it("counts Cashu sats set aside for a payment in the total, says so on the Cashu row, and leaves them out of what is ready now", async () => {
    const { user } = await openOn("testnet", { setAside: 4_000 });
    // 4,000 (Cashu, set aside) + 5,000 (Ark) + 210,000 (on-chain, 40,000 of it unconfirmed).
    expect(screen.getByTestId("wallet-total-bitcoin-amount")).toHaveTextContent("219,000test sats");
    await user.click(screen.getByTestId("wallet-total-bitcoin"));
    expect(screen.getByTestId("wallet-total-ready-amount")).toHaveTextContent("175,000 test sats");
    expect(row("cashu-testnet")).toHaveTextContent("4,000 test sats not spendable yet");
    expect(within(row("cashu-testnet")).getByTestId("wallet-total-line-amount")).toHaveTextContent("4,000 test sats");
  });

  it("shows a shared balance's number on one card only: Lightning through the mints says it uses Cashu's", async () => {
    const { user } = await openOn("mainnet");
    expect(screen.getByTestId("wallet-card-cashu-mainnet")).toHaveTextContent("1,000 sats");
    const lightning = screen.getByTestId("wallet-card-lightning-mainnet");
    expect(lightning).toHaveTextContent("Uses your Cashu balance");
    expect(lightning).not.toHaveTextContent("1,000");
    expect(lightning).not.toHaveTextContent(/\bsats\b/);
    // The total and where it comes from are as they were: counted once, the row still says so with its amount.
    expect(screen.getByTestId("wallet-total-bitcoin-amount")).toHaveTextContent("1,000sats");
    await user.click(screen.getByTestId("wallet-total-bitcoin"));
    expect(row("lightning-mainnet")).toHaveTextContent("Same balance as Cashu, counted once");
    expect(within(row("lightning-mainnet")).getByTestId("wallet-total-line-amount")).toHaveTextContent("1,000 sats");
  });

  it("keeps the number in a shared-balance card's panel, with a line saying whose balance it is; the Cashu panel has none", async () => {
    const { user } = await openOn("mainnet");
    expect(await screen.findByTestId("wallet-balance")).toHaveTextContent("1,000");
    expect(screen.queryByTestId("wallet-shared-balance")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("wallet-card-lightning-mainnet"));
    expect(await screen.findByTestId("wallet-shared-balance")).toHaveTextContent("Same balance as your Cashu card");
    expect(await screen.findByTestId("wallet-balance")).toHaveTextContent("1,000");
  });

  it("opens USDT's own breakdown, with no ready line, and closes from its button", async () => {
    const { user } = await openOn("testnet");
    await user.click(screen.getByTestId("wallet-total-usdt"));
    const breakdown = screen.getByTestId("wallet-total-breakdown");
    expect(breakdown).toHaveAttribute("data-currency", "usdt");
    expect(within(breakdown).getByTestId("wallet-total-sum-amount")).toHaveTextContent("12.5 TEST-USDT");
    expect(within(breakdown).queryByTestId("wallet-total-ready")).not.toBeInTheDocument();
    expect(within(breakdown).getAllByTestId(/^wallet-total-row-/).map((r) => r.dataset.testid)).toEqual(["wallet-total-row-usdt-testnet"]);
    await user.click(within(breakdown).getByTestId("wallet-total-close"));
    expect(screen.queryByTestId("wallet-total-breakdown")).not.toBeInTheDocument();
  });

  it("speaks the app's language: Portuguese words and number formats", async () => {
    const view = renderApp(<Wallet />, { language: "pt" });
    view.engine.update({ wallet: wallet() });
    await view.user.click(await screen.findByTestId("wallet-network-testnet"));
    expect(screen.getByTestId("wallet-total-bitcoin-amount")).toHaveTextContent("215.000");
    expect(screen.getByTestId("wallet-total-bitcoin-uncounted")).toHaveTextContent("1 cartão fora do total");
    await view.user.click(screen.getByTestId("wallet-total-bitcoin"));
    expect(screen.getByTestId("wallet-total-ready")).toHaveTextContent("Pronto para gastar agora");
  });
});

// covers: wallet.instances.first-run
describe("the first-run wallet setup's Try again and Skip, from the keyboard", () => {
  /*
   * A new profile's Mainnet wallets that could not be made, on the Wallet page: Try again and Skip pressed from the
   * keyboard. The focus stays on Try again while it works and after it fails again, and once a row goes (skipped, or
   * made) it moves to the next row's Try again, or to New when none is left. A disabled button, or one that goes, dropped
   * a keyboard's focus to the page in Chrome and WebKit, and the next Tab started from the top.
   */

  /** What Chrome and WebKit do to a focused button that turns disabled: they take its focus away. happy-dom keeps it. */
  function browserDropsFocus() {
    const active = document.activeElement;
    if (active instanceof HTMLButtonElement && active.disabled) act(() => { active.disabled = false; active.blur(); active.disabled = true; });
  }

  const offers = (): WalletOffer[] => (["cashu", "usdt"] as const).flatMap((type) => (["mainnet", "testnet"] as const).map((network) => ({ type, network, available: true })));
  const failed = (...types: ("cashu" | "usdt")[]): WalletSetupView["failed"] =>
    types.map((type) => ({ type, network: "mainnet", reason: `Could not reach ${type === "cashu" ? "mint.example" : "rpc.example"}` }));

  function setup(view: WalletSetupView) {
    const rendered = renderApp(<Wallet />);
    const show = (next: WalletSetupView) => act(() => { rendered.engine.update({ wallet: walletView({ offers: offers(), setup: next }) }); });
    show(view);
    return { ...rendered, show };
  }

  it("Try again keeps the focus while it runs, and has it again when it fails again", async () => {
    let done: () => void = () => {};
    const { user, engine, show } = setup({ running: false, failed: failed("cashu", "usdt") });
    engine.on("walletSetupRetry", () => new Promise<void>((resolve) => { done = resolve; }));
    const retry = await screen.findByTestId("wallet-setup-retry-cashu");
    retry.focus();
    await user.keyboard("{Enter}");
    // The engine says the run is under way.
    show({ running: true, failed: failed("cashu", "usdt") });
    await waitFor(() => expect(retry).toHaveTextContent("Creating"));
    browserDropsFocus();
    expect(retry).toHaveFocus();
    expect(retry).toHaveAttribute("aria-busy", "true");
    // It failed again: the row stays, Try again with it.
    show({ running: false, failed: failed("cashu", "usdt") });
    await act(async () => done());
    browserDropsFocus();
    expect(screen.getByTestId("wallet-setup-retry-cashu")).toHaveFocus();
    expect(engine.callsTo("walletSetupRetry")).toEqual([{ type: "cashu" }]);
  });

  it("Skip moves the focus to the next row's Try again, and the last one to New", async () => {
    const { user, engine, show } = setup({ running: false, failed: failed("cashu", "usdt") });
    engine.on("walletSetupDismiss", ({ type }) => { show({ running: false, failed: failed(...(["cashu", "usdt"] as const).filter((t) => t !== type && !engine.callsTo("walletSetupDismiss").some((c) => c.type === t))) }); });
    (await screen.findByTestId("wallet-setup-skip-cashu")).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByTestId("wallet-setup-skip-cashu")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("wallet-setup-retry-usdt")).toHaveFocus());

    screen.getByTestId("wallet-setup-skip-usdt").focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByTestId("wallet-setup")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("wallet-add")).toHaveFocus());
  });

  it("a Try again that makes the wallet moves the focus on, as Skip does", async () => {
    const { user, engine, show } = setup({ running: false, failed: failed("cashu") });
    engine.on("walletSetupRetry", () => { show({ running: false, failed: [] }); });
    (await screen.findByTestId("wallet-setup-retry-cashu")).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByTestId("wallet-setup")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("wallet-add")).toHaveFocus());
  });
});

// covers: wallet.deck
describe("the Wallets page on an engine state", () => {
  /**
   * The engine sends its whole state anew on every change, up to 20 times a second while a file moves. The Wallets page
   * (its deck and the open wallet's panel) draws again only when the wallets change, not on every state.
   */

  function openWallet() {
    fakeEngine.setState({ wallet: walletView(everyWallet()) });
    let commits = 0;
    renderApp(
      <Profiler id="wallet" onRender={() => { commits++; }}>
        <Routes><Route path="/wallet" element={<Wallet />} /></Routes>
      </Profiler>,
      { route: "/wallet" },
    );
    return { commits: () => commits };
  }

  /** The state as the engine sends it after a change elsewhere: the same content, every object new. */
  const sentAgain = (patch: StatePatch = {}) => act(() => fakeEngine.setState({ ...structuredClone(fakeEngine.state), ...patch } as StatePatch));

  it("is not drawn again when the wallets did not change", async () => {
    const { commits } = openWallet();
    expect(await screen.findByTestId("wallet-panel")).toBeInTheDocument();
    const before = commits();
    for (let i = 0; i < 5; i++) sentAgain({ transfers: { [`file-${i}`]: { state: "transferring", transferred: i * 1000, size: 10_000 } } });
    expect(commits() - before).toBe(0);
  });

  it("is drawn again when a wallet changes", async () => {
    const { commits } = openWallet();
    expect(await screen.findByTestId("wallet-panel")).toHaveTextContent("1,000");
    const before = commits();
    sentAgain({ wallet: walletView(everyWallet({ mints: [mint(REAL_MINT, 2_500)], balance: 2_500 })) });
    expect(await screen.findByTestId("wallet-panel")).toHaveTextContent("2,500");
    expect(commits() - before).toBeGreaterThanOrEqual(1);
  });
});

// covers: app.i18n, wallet.instances.create
describe("the Wallets page in the app's language", () => {
  /** Something like `wallet.first.title`: what `t()` shows for a key its locale lacks. */
  const RAW_KEY = new RegExp(`\\b(?:${SECTIONS.join("|")})(?:\\.[a-zA-Z]+)+\\b`);

  describe("the first wallet card speaks the app's language", () => {
    it("in Portuguese", async () => {
      const { engine } = renderApp(<Wallet />, { language: "pt" });
      engine.update({ wallet: walletView({}) });
      const card = await screen.findByTestId("wallet-first");
      expect(card).toHaveTextContent("Crie sua primeira carteira");
      expect(screen.getByTestId("wallet-first-testnet")).toHaveTextContent("Começar na Testnet");
      expect(card).not.toHaveTextContent("Create your first wallet");
    });

    it("in Arabic, with the sentence around New from the translation", async () => {
      const { engine } = renderApp(<Wallet />, { language: "ar" });
      engine.update({ wallet: walletView({}) });
      const card = await screen.findByTestId("wallet-first");
      expect(card).toHaveTextContent("أنشئ محفظتك الأولى");
      const orNew = screen.getByTestId("wallet-first-new").parentElement!;
      expect(orNew.textContent).toBe(lookup("ar", "wallet.first.orNew")!.replace("{{new}}", lookup("ar", "sidebar.new")!));
      expect(card).not.toHaveTextContent(/[A-Za-z]{4,} (?:your|wallet|with)/);
    });

    it.each(LANGUAGES)("in %s, with no raw key", async (language) => {
      const { engine, container } = renderApp(<Wallet />, { language });
      engine.update({ wallet: walletView({}) });
      expect(await screen.findByTestId("wallet-first")).toHaveTextContent(lookup(language, "wallet.first.title")!);
      expect(container.textContent).not.toMatch(RAW_KEY);
    });
  });

  describe("the deck's arrows", () => {
    it("are named in the app's language for a screen reader", async () => {
      const { engine, user } = renderApp(<Wallet />, { language: "pt" });
      engine.update({ wallet: walletView({ mints: [mint(TEST_MINT, 10_000)], balance: 10_000 }) });
      await user.click(await screen.findByTestId("wallet-network-testnet"));
      expect(await screen.findByTestId("wallet-deck-testnet-prev")).toHaveAccessibleName("Cartão anterior");
      expect(screen.getByTestId("wallet-deck-testnet-next")).toHaveAccessibleName("Próximo cartão");
    });
  });
});

// covers: wallet.badge, app.responsive
describe("the new-sats dot on the wallet icon", () => {
  const arrive = (balance: number, mode: "mainnet" | "testnet" = "mainnet") => act(() => fakeEngine.update({ wallet: walletView({ mode, balance }) }));

  describe("the wallets read as the app starts", () => {
    it("are not new sats", () => {
      // As the engine starts: its empty view first (no networks yet), then the wallets read from the device.
      fakeEngine.emit({ kind: "state", state: { ...fakeEngine.state, wallet: { mints: [], balance: 0, history: [], feesPaid: 0 } } });
      renderApp(<AccountBar />);
      arrive(109_100);
      expect(screen.queryByTestId("wallet-new")).not.toBeInTheDocument();
      expect(screen.getByTestId("wallet-chip")).toHaveAccessibleName("Wallets");
      arrive(110_000);
      expect(screen.getByTestId("wallet-chip")).toHaveAccessibleName("Wallets, 900 new sats");
    });
  });

  /** Sats that came in while the wallet was closed: a dot on the wallet icon, the amount only in its name and tooltip. */
  describe("the wallet's new-sats dot", () => {
    // The wallets as read when the app started: empty.
    beforeEach(() => { fakeEngine.update({ wallet: walletView() }); });

    it("real sats: a filled dot, the amount in the name and tooltip, no number on the bar", () => {
      renderApp(<AccountBar />);
      expect(screen.queryByTestId("wallet-new")).not.toBeInTheDocument();
      expect(screen.getByTestId("wallet-chip")).toHaveAccessibleName("Wallets");

      arrive(109_100);
      const dot = screen.getByTestId("wallet-new");
      expect(dot).toHaveClass("nav-dot");
      expect(dot).not.toHaveClass("nav-dot-test");
      expect(dot).toBeEmptyDOMElement();
      expect(screen.getByTestId("wallet-chip")).toHaveAccessibleName("Wallets, 109,100 new sats");
      expect(screen.getByTestId("wallet-chip")).toHaveAttribute("title", "Wallets, 109,100 new sats");
      expect(screen.getByTestId("account-bar")).not.toHaveTextContent(/\d/);
    });

    it("test sats only: the same dot, hollow, and the name says test sats", () => {
      renderApp(<AccountBar />);
      arrive(21, "testnet");
      expect(screen.getByTestId("wallet-new")).toHaveClass("nav-dot", "nav-dot-test");
      expect(screen.getByTestId("wallet-chip")).toHaveAccessibleName("Wallets, 21 new test sats");
    });

    it("a single sat is said as one", () => {
      renderApp(<AccountBar />);
      arrive(1);
      expect(screen.getByTestId("wallet-chip")).toHaveAccessibleName("Wallets, 1 new sat");
    });

    it("a single test sat is said as one, in Portuguese too", () => {
      renderApp(<AccountBar />, { language: "pt" });
      arrive(1, "testnet");
      expect(screen.getByTestId("wallet-chip")).toHaveAccessibleName(/, 1 sat de teste novo$/);
    });

    it("says it in the app's language and number format, test sats as test sats", () => {
      renderApp(<AccountBar />, { language: "pt" });
      arrive(1_500, "testnet");
      expect(screen.getByTestId("wallet-chip")).toHaveAccessibleName(/, 1\.500 sats de teste novos$/);
      expect(screen.getByTestId("wallet-chip")).not.toHaveAccessibleName(/new/);
    });

    it("stays while the Wallets page shows their network, goes once it is left; nothing shows for sats that arrive there", async () => {
      // A Mainnet Cashu wallet: the page opens on Mainnet.
      const cashu = (sats: number) => act(() => fakeEngine.update({ wallet: walletView({ mints: [mint(REAL_MINT, sats)], balance: sats }) }));
      fakeEngine.update({ wallet: walletView({ mints: [mint(REAL_MINT, 0)] }) });
      const { user } = renderApp(<><AccountBar /><Routes><Route path="/wallet" element={<Wallet />} /><Route path="*" element={null} /></Routes></>);
      cashu(500);
      await user.click(screen.getByTestId("wallet-chip"));
      expect(screen.getByTestId("wallet-new")).toBeInTheDocument();
      cashu(900);
      expect(screen.getByTestId("wallet-chip")).toHaveAccessibleName("Wallets, 500 new sats");
      await user.click(screen.getByTestId("wallet-chip"));
      await waitFor(() => expect(screen.queryByTestId("wallet-new")).not.toBeInTheDocument());
      expect(screen.getByTestId("wallet-chip")).toHaveAccessibleName("Wallets");
    });

    it("on a phone: the Wallets tab carries it, counting what came in while a chat hid the tab bar", () => {
      const { unmount } = renderApp(<MobileTabBar />);
      unmount();
      arrive(2_000);
      renderApp(<MobileTabBar />);
      const dot = screen.getByTestId("wallet-new");
      expect(dot).toHaveClass("nav-dot", "nav-dot-tab");
      expect(screen.getByTestId("mobile-tab-wallet")).toHaveAccessibleName("Wallets, 2,000 new sats");
      expect(screen.getByTestId("mobile-tabs")).not.toHaveTextContent(/\d/);
    });
  });
});

// covers: wallet.test-coins
describe("a Testnet wallet's test coins", () => {
  /** Opens the Wallets page on one card, on its network's tab. */
  async function open(wallet: WalletView, card: string, language?: "ar") {
    const app = renderApp(<Wallet />, language ? { language } : undefined);
    app.engine.update({ wallet });
    await app.user.click(await screen.findByTestId(`wallet-network-${card.split("-")[1]}`));
    await app.user.click(await screen.findByTestId(`wallet-card-${card}`));
    return app;
  }

  describe("Get test coins", () => {
    it("is on a Testnet wallet's details, labelled test money, and not on a Mainnet one", async () => {
      const { user } = await open(walletView({ mints: [mint(TEST_MINT, 0), mint(REAL_MINT, 0)] }), "cashu-testnet");
      const section = await screen.findByTestId("test-coins");
      expect(within(section).getByTestId("test-coins-network")).toHaveTextContent("Test money");
      expect(section).toHaveTextContent("10,000 test sats from the test mint, only when you press the button");
      expect(within(section).getByTestId("test-coins-get")).toHaveTextContent("Get test coins");
      await user.click(screen.getByTestId("wallet-network-mainnet"));
      await waitFor(() => expect(screen.getByTestId("wallet-panel")).toHaveAttribute("data-network", "mainnet"));
      await waitFor(() => expect(screen.queryByTestId("test-coins")).not.toBeInTheDocument());
      expect(screen.queryByTestId("test-coins-get")).not.toBeInTheDocument();
    });

    it("says it is asking, then what came in", async () => {
      const { user, engine } = await open(walletView({ mints: [mint(TEST_MINT, 0)] }), "cashu-testnet");
      let pay!: () => void;
      engine.on("walletTestCoins", () => new Promise((resolve) => { pay = () => resolve({ amount: 10_000, unit: "test sats" }); }));
      const get = await screen.findByTestId("test-coins-get");
      get.focus();
      await user.keyboard("{Enter}");
      expect(get).toHaveTextContent("Asking the faucet…");
      // Busy, not disabled: a disabled button drops the keyboard's focus to the page (Chromium), and a press does nothing.
      expect(get).toHaveAttribute("aria-busy", "true");
      expect(get).toHaveAttribute("aria-disabled", "true");
      expect(get).toBeEnabled();
      await user.keyboard("{Enter}");
      pay();
      expect(await screen.findByTestId("test-coins-result")).toHaveTextContent("+10,000 test sats");
      expect(get).toHaveTextContent("Get test coins");
      expect(get).toHaveFocus();
      expect(engine.callsTo("walletTestCoins")).toEqual([{ type: "cashu", network: "testnet" }]);
    });

    it("an error says why, and Retry asks again", async () => {
      const { user, engine } = await open(walletView({ mints: [mint(TEST_MINT, 0)] }), "lightning-testnet");
      engine.on("walletTestCoins", () => { throw new Error("Rate limited: the faucet is busy. Try again in a minute."); });
      await user.click(await screen.findByTestId("test-coins-get"));
      expect(await screen.findByTestId("test-coins-error")).toHaveTextContent("Rate limited: the faucet is busy. Try again in a minute.");
      engine.on("walletTestCoins", () => ({ amount: 10_000, unit: "test sats" }));
      await user.click(screen.getByTestId("test-coins-retry"));
      expect(await screen.findByTestId("test-coins-result")).toHaveTextContent("+10,000 test sats");
      expect(screen.queryByTestId("test-coins-error")).not.toBeInTheDocument();
      // Retry went with its error: the keys are on Get test coins, not on the page.
      expect(screen.getByTestId("test-coins-get")).toHaveFocus();
      expect(engine.callsTo("walletTestCoins")).toEqual([{ type: "lightning", network: "testnet" }, { type: "lightning", network: "testnet" }]);
    });

    it("USDT on Sepolia: needs gas first, then 1,000 TEST-USDT on the way", async () => {
      const { user, engine } = await open(walletView({ usdt: usdtReady({ token: SEPOLIA_TEST_USDT, network: "sepolia", gasBalance: "0" }) }), "usdt-testnet");
      expect(await screen.findByTestId("test-coins-get")).toBeDisabled();
      expect(screen.getByTestId("test-coins-needs")).toHaveTextContent("Sepolia ETH for gas");
      engine.update({ wallet: walletView({ usdt: usdtReady({ token: SEPOLIA_TEST_USDT, network: "sepolia", gasBalance: "1000000000000000" }) }) });
      await waitFor(() => expect(screen.getByTestId("test-coins-get")).toBeEnabled());
      engine.on("walletTestCoins", () => ({ amount: 1_000, unit: "TEST-USDT", pending: true }));
      await user.click(screen.getByTestId("test-coins-get"));
      expect(await screen.findByTestId("test-coins-result")).toHaveTextContent("+1,000 TEST-USDT on the way");
    });

    it("in Arabic, the \"+\" stays at its number's left: the signed amount is its own left-to-right run", async () => {
      const { user, engine } = await open(walletView({ mints: [mint(TEST_MINT, 0)] }), "cashu-testnet", "ar");
      engine.on("walletTestCoins", () => ({ amount: 10_000, unit: "test sats" }));
      await user.click(await screen.findByTestId("test-coins-get"));
      const result = await screen.findByTestId("test-coins-result");
      expect([...result.querySelectorAll('[dir="ltr"]')].map((el) => el.textContent)).toEqual(["+10,000"]);
      engine.on("walletTestCoins", () => ({ amount: 1_000, unit: "TEST-USDT", pending: true }));
      await user.click(screen.getByTestId("test-coins-get"));
      await waitFor(() => expect([...screen.getByTestId("test-coins-result").querySelectorAll('[dir="ltr"]')].map((el) => el.textContent)).toEqual(["+1,000"]));
    });

    it("a faucet behind a login is a link, never asked by Ghostly", async () => {
      await open(walletView({ ark: arkReady({ network: "mutinynet" }) }), "arkade-testnet");
      const link = await screen.findByTestId("test-coins-open");
      expect(link).toHaveAttribute("href", "https://faucet.mutinynet.com");
      expect(link).toHaveAttribute("target", "_blank");
      expect(screen.getByTestId("test-coins")).toHaveTextContent("GitHub login");
      expect(screen.queryByTestId("test-coins-get")).not.toBeInTheDocument();
    });
  });

  describe("which faucet a Testnet wallet has", () => {
    const on = (patch: Partial<WalletView>) => networkState(walletView(patch), "testnet");
    it("asks only the faucets that need nothing; links the ones behind a login or a CAPTCHA; none on Mainnet or a local chain", () => {
      expect(faucetFor("cashu", "testnet", on({ mints: [mint(TEST_MINT, 0)] }))).toMatchObject({ kind: "ask" });
      expect(faucetFor("cashu", "mainnet", networkState(walletView({ mints: [mint(REAL_MINT, 0)] }), "mainnet"))).toBeNull();
      expect(faucetFor("lightning", "testnet", on({ mints: [mint(TEST_MINT, 0)], lightning: lightningSource({ mode: "testnet", providerId: "breez" }) }))).toMatchObject({ kind: "open", url: "https://app.lightspark.com/regtest-faucet" });
      expect(faucetFor("lightning", "testnet", on({ lightning: lightningSource({ mode: "testnet", providerId: "lnd" }) }))).toBeNull();
      expect(faucetFor("bark", "testnet", on({ bark: barkReady() }))).toMatchObject({ kind: "open", url: "https://signet.2nd.dev" });
      expect(faucetFor("spark", "testnet", on({ spark: sparkReady() }))).toMatchObject({ kind: "open" });
      expect(faucetFor("bitcoin", "testnet", on({ bitcoin: bitcoinSource({ mode: "testnet", network: "signet" }) }))).toMatchObject({ kind: "open", url: "https://signetfaucet.com" });
      expect(faucetFor("bitcoin", "testnet", on({ bitcoin: bitcoinSource({ mode: "testnet", network: "regtest" }) }))).toBeNull();
      expect(faucetFor("arkade", "testnet", on({ ark: arkReady({ network: "regtest" }) }))).toBeNull();
      expect(faucetFor("usdt", "testnet", on({ usdt: usdtReady({ network: "evm-local", chainId: 31337, token: "0x5FbDB2315678afecb367f032d93F642f64180aa3" }) }))).toBeNull();
      expect(faucetFor("fedimint", "testnet", on({}))).toBeNull();
    });
  });
});

// covers: payments.cashu.reclaim
describe("ecash sent in a deleted chat, on the Wallet page", () => {
  /**
   * Ecash sent in a chat that was deleted before the contact took it: the engine keeps it so it can be taken back, but
   * the chat's bubble (Take it back) went with the chat. The Wallet page offers it instead, and Remove wallet too.
   */
  function awaitingOn(wallet: WalletView, network: WalletNetwork, awaiting: WalletAwaitingView[]): WalletView {
    return { ...wallet, networks: { ...wallet.networks!, [network]: { ...wallet.networks![network], awaiting } } };
  }
  const testWallet = (balance: number, awaiting: WalletAwaitingView[]) => awaitingOn(walletView({ mode: "testnet", mints: [mint(TEST_MINT, balance)], balance }), "testnet", awaiting);

  it("is listed with Take it back; taking it back brings the sats back and the row goes", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: testWallet(87, [{ type: "cashu", kind: "sent", amount: 13, paymentId: "p1", chatGone: true }]) });
    const section = await screen.findByTestId("wallet-sent-ecash");
    expect(within(section).getByRole("heading")).toHaveTextContent("Sent in a deleted chat");
    const [row] = within(section).getAllByTestId("wallet-sent-ecash-item");
    expect(row).toHaveTextContent("13 test sats in ecash you sent, not taken yet");
    expect(row).toHaveTextContent("If your contact never picks it up, the ecash is still yours");
    // The engine takes it back as from the chat's bubble: the sats are in the wallet again, and nothing waits.
    engine.on("reclaimPayment", () => { engine.update({ wallet: testWallet(100, []) }); });
    await user.click(within(row!).getByRole("button", { name: "Take it back" }));
    expect(engine.callsTo("reclaimPayment")).toEqual([{ paymentId: "p1" }]);
    await waitFor(() => expect(screen.queryByTestId("wallet-sent-ecash")).not.toBeInTheDocument());
    expect(screen.getByTestId("wallet-card-cashu-testnet")).toHaveTextContent("100");
  });

  it("keeps the keyboard focus as rows go: on the next row's Take it back, then on the total the sats came back to", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: testWallet(74, [
      { type: "cashu", kind: "sent", amount: 13, paymentId: "p1", chatGone: true },
      { type: "cashu", kind: "sent", amount: 13, paymentId: "p2", chatGone: true },
    ]) });
    engine.on("reclaimPayment", ({ paymentId }) => {
      engine.update({ wallet: paymentId === "p1" ? testWallet(87, [{ type: "cashu", kind: "sent", amount: 13, paymentId: "p2", chatGone: true }]) : testWallet(100, []) });
    });
    const first = (await screen.findAllByTestId("wallet-sent-ecash-take-back"))[0]!;
    first.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getAllByTestId("wallet-sent-ecash-item")).toHaveLength(1));
    // On the next row's Take it back, or on the list while that is still disabled by the run: Tab goes on to it.
    const second = screen.getByTestId("wallet-sent-ecash-take-back");
    await waitFor(() => expect(screen.getByTestId("wallet-sent-ecash").parentElement!.contains(document.activeElement)).toBe(true));
    if (document.activeElement !== second) await user.tab();
    expect(second).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByTestId("wallet-sent-ecash")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("wallet-total-bitcoin")).toHaveFocus());
    expect(screen.getByTestId("wallet-total-bitcoin-amount")).toHaveTextContent("100");
  });

  it("is not listed while its chat is there: the chat's bubble offers it back", async () => {
    const { engine } = renderApp(<Wallet />);
    engine.update({ wallet: testWallet(87, [{ type: "cashu", kind: "sent", amount: 13, paymentId: "p1" }]) });
    await screen.findByTestId("wallet-card-cashu-testnet");
    expect(screen.queryByTestId("wallet-sent-ecash")).not.toBeInTheDocument();
  });

  it("says why when it cannot be taken back, and keeps the row", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: testWallet(87, [{ type: "cashu", kind: "sent", amount: 13, paymentId: "p1", chatGone: true }]) });
    engine.on("reclaimPayment", () => { throw new Error("Nothing to reclaim"); });
    await user.click(await screen.findByTestId("wallet-sent-ecash-take-back"));
    expect(await screen.findByTestId("wallet-sent-ecash-error")).toHaveTextContent("Nothing to take back");
    expect(screen.getByTestId("wallet-sent-ecash-item")).toBeInTheDocument();
  });

  it("Remove wallet offers Take it back on the ecash it lists as not taken yet", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: testWallet(87, [{ type: "cashu", kind: "sent", amount: 13, paymentId: "p1", chatGone: true }]) });
    await user.click(await screen.findByTestId("wallet-card-cashu-testnet"));
    await user.click(await screen.findByTestId("wallet-remove"));
    const dialog = screen.getByTestId("wallet-remove-dialog");
    expect(within(dialog).getByTestId("wallet-remove-returnable")).toHaveTextContent("Ecash you sent from this wallet has not been taken yet (13 test sats).");
    const [item] = within(dialog).getAllByTestId("wallet-remove-returnable-item");
    expect(item).toHaveTextContent("13 test sats in ecash you sent, not taken yet");
    engine.on("reclaimPayment", () => { engine.update({ wallet: testWallet(100, []) }); });
    await user.click(within(item!).getByRole("button", { name: "Take it back" }));
    expect(engine.callsTo("reclaimPayment")).toEqual([{ paymentId: "p1" }]);
    await waitFor(() => expect(within(dialog).queryByTestId("wallet-remove-returnable")).not.toBeInTheDocument());
    expect(within(dialog).getByTestId("wallet-remove-held")).toHaveTextContent("100 test sats");
  });
});

// covers: wallet.backup-reminder
describe("a wallet's backup reminder", () => {
  const funded = (at = Date.now() - 1000) => ({ funded: at });
  /** Mainnet Cashu with 50 sats and Mainnet USDT with 5 USDT, and the reminders the engine keeps for them. */
  const real = (backupReminders: BackupReminders): WalletView => walletView({ mints: [mint(REAL_MINT, 50)], usdt: usdtReady({ chainId: 1, network: "ethereum" }), backupReminders });

  /** Where the app went: the page it is on and the state it carried. */
  function Probe() {
    const location = useLocation();
    return <p data-testid="probe">{location.pathname} {JSON.stringify(location.state)}</p>;
  }
  function openWallet(wallet: WalletView) {
    const app = renderApp(<Routes><Route path="/wallet" element={<Wallet />} /><Route path="*" element={<Probe />} /></Routes>, { route: "/wallet" });
    act(() => app.engine.update({ wallet }));
    return app;
  }

  describe("the backup reminder on the Wallet page", () => {
    it("Cashu with real money: one calm card, its button opens the profile's backups", async () => {
      const { user } = openWallet(real({ "cashu:mainnet": funded() }));
      const card = await screen.findByTestId("backup-reminder");
      expect(card).toHaveAttribute("data-wallet", "cashu:mainnet");
      expect(card).toHaveTextContent("You have real money in Cashu");
      expect(card).toHaveTextContent("Back it up so you don't lose it if this device is lost.");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      // The why is behind the ⓘ.
      await user.click(screen.getByTestId("row-info"));
      expect(screen.getByTestId("row-info-text")).toHaveTextContent("Cashu has no recovery phrase");
      await user.click(screen.getByTestId("backup-reminder-go"));
      expect(await screen.findByTestId("probe")).toHaveTextContent(/^\/profile .*"backupProfile":true/);
    });

    it("USDT with real money: its button opens the wallet on its recovery phrase", async () => {
      const { user } = openWallet(real({ "usdt:mainnet": funded() }));
      const go = await screen.findByTestId("backup-reminder-go");
      expect(go).toHaveTextContent("Show recovery phrase");
      await user.click(go);
      await waitFor(() => expect(screen.getByTestId("usdt-recovery-show")).toHaveFocus());
      expect(screen.getByTestId("wallet-panel")).toHaveAttribute("data-network", "mainnet");
    });

    it("Later asks the engine to put that wallet off", async () => {
      const { user, engine } = openWallet(real({ "cashu:mainnet": funded() }));
      engine.on("walletBackupReminder", () => undefined);
      await user.click(await screen.findByTestId("backup-reminder-later"));
      expect(engine.callsTo("walletBackupReminder")).toEqual([{ event: "later", wallet: "cashu:mainnet" }]);
    });

    it("Later from the keyboard: the keys go to the next reminder's button, then to the network tab, never to the page", async () => {
      const { user, engine } = openWallet(real({ "cashu:mainnet": funded(), "usdt:mainnet": funded() }));
      engine.on("walletBackupReminder", () => undefined);
      const first = (await screen.findByTestId("backup-reminder")).dataset.wallet!;
      const next = first === "cashu:mainnet" ? "usdt:mainnet" : "cashu:mainnet";
      screen.getByTestId("backup-reminder-later").focus();
      await user.keyboard("{Enter}");
      act(() => engine.update({ wallet: real({ [first]: { funded: 1, later: Date.now(), laterBalance: "5000000", laters: 1 }, [next]: funded() }) }));
      expect(await screen.findByTestId("backup-reminder")).toHaveAttribute("data-wallet", next);
      await waitFor(() => expect(screen.getByTestId("backup-reminder-go")).toHaveFocus());

      screen.getByTestId("backup-reminder-later").focus();
      await user.keyboard("{Enter}");
      act(() => engine.update({ wallet: real({ "cashu:mainnet": { funded: 1, later: Date.now(), laterBalance: "50", laters: 1 }, "usdt:mainnet": { funded: 1, later: Date.now(), laterBalance: "5000000", laters: 1 } }) }));
      await waitFor(() => expect(screen.queryByTestId("backup-reminder")).not.toBeInTheDocument());
      const inView = screen.getByTestId("wallet-network-panel").dataset.network;
      await waitFor(() => expect(screen.getByTestId(`wallet-network-${inView}`)).toHaveFocus());
    });

    it("Later refused: the card stays and says so, the keys still on Later; pressed again, the line goes", async () => {
      const { user, engine } = openWallet(real({ "cashu:mainnet": funded() }));
      let refuse = true;
      engine.on("walletBackupReminder", () => { if (refuse) throw new Error("backup reminders unavailable"); });
      const later = await screen.findByTestId("backup-reminder-later");
      later.focus();
      await user.keyboard("{Enter}");
      expect(await screen.findByTestId("backup-reminder-error")).toHaveTextContent("Could not put the reminder off. Try again.");
      expect(screen.getByTestId("backup-reminder")).toHaveAttribute("data-wallet", "cashu:mainnet");
      expect(later).toHaveFocus();
      refuse = false;
      await user.keyboard("{Enter}");
      await waitFor(() => expect(screen.queryByTestId("backup-reminder-error")).not.toBeInTheDocument());
      expect(engine.callsTo("walletBackupReminder")).toHaveLength(2);
    });

    it("shows nothing once backed up, while put off, or for test coins", () => {
      const { engine } = openWallet(real({ "cashu:mainnet": { funded: 1, backedUp: 2 }, "usdt:mainnet": { funded: 1, later: Date.now(), laterBalance: "5000000", laters: 1 } }));
      expect(screen.queryByTestId("backup-reminder")).not.toBeInTheDocument();
      act(() => engine.update({ wallet: walletView({ mints: [mint(TEST_MINT, 10_000)], backupReminders: { "cashu:testnet": funded() } }) }));
      expect(screen.queryByTestId("backup-reminder")).not.toBeInTheDocument();
    });
  });

  describe("the wallet icon while a backup reminder asks", () => {
    it("wears a dot and says so in its name; the new-sats dot takes its place, one dot at most", () => {
      const { engine } = renderApp(<AccountBar />);
      expect(screen.queryByTestId("wallet-backup-due")).not.toBeInTheDocument();
      act(() => engine.update({ wallet: real({ "cashu:mainnet": funded() }) }));
      expect(screen.getByTestId("wallet-backup-due")).toHaveClass("nav-dot");
      expect(screen.getByTestId("wallet-chip")).toHaveAccessibleName(/^Wallets(, [\d,]+ new sats)?, backup needed$/);
      act(() => engine.update({ wallet: real({ "cashu:mainnet": { funded: 1, backedUp: 2 } }) }));
      expect(screen.queryByTestId("wallet-backup-due")).not.toBeInTheDocument();
    });

    it("on a phone, the Wallets tab carries it", () => {
      const { engine } = renderApp(<MobileTabBar />);
      act(() => engine.update({ wallet: real({ "usdt:mainnet": funded() }) }));
      expect(screen.getByTestId("mobile-tab-wallet")).toHaveAccessibleName(/backup needed$/);
      expect(document.querySelectorAll("[data-testid=wallet-backup-due], [data-testid=wallet-new]")).toHaveLength(1);
    });
  });

  describe("the profile's backups, reached from the reminder", () => {
    it("open on Back up, the passphrase in focus", async () => {
      renderApp(<ProfileBackups canSwitch={false} openBackup />);
      await waitFor(() => expect(screen.getByTestId("backup-passphrase")).toHaveFocus());
    });
  });
});

// covers: wallet.instances.remove
describe("Remove, in a wallet's details", () => {
  /** Opens the Wallets page on one card, and its Remove dialog. */
  async function removing(wallet: WalletView, card: string, language?: Language) {
    const app = renderApp(<Wallet />, { language });
    app.engine.update({ wallet });
    await app.user.click(await screen.findByTestId(`wallet-card-${card}`));
    await app.user.click(await screen.findByTestId("wallet-remove"));
    return { ...app, dialog: screen.getByTestId("wallet-remove-dialog") };
  }

  /** The view, with what one network's wallets still wait for (the engine reads it from quotes, journals and payments). */
  function awaitingOn(wallet: WalletView, network: WalletNetwork, awaiting: WalletAwaitingView[]): WalletView {
    return { ...wallet, networks: { ...wallet.networks!, [network]: { ...wallet.networks![network], awaiting } } };
  }

  it("an empty Testnet wallet goes on one plain confirm; the next card of its network comes up", async () => {
    const { user, engine, dialog } = await removing(walletView({ mints: [mint(TEST_MINT, 0)], ark: arkReady({ balance: 0 }) }), "arkade-testnet");
    expect(within(dialog).getByRole("heading")).toHaveTextContent("Remove your Testnet Ark wallet?");
    expect(within(dialog).getByTestId("wallet-remove-network")).toHaveTextContent("Test money");
    expect(within(dialog).getByTestId("wallet-remove-held")).toHaveTextContent("It holds nothing.");
    // Nothing to lose: no backup step, no checkbox.
    expect(within(dialog).queryByTestId("wallet-remove-backup")).not.toBeInTheDocument();
    expect(within(dialog).queryByTestId("wallet-remove-understood")).not.toBeInTheDocument();
    engine.on("walletRemove", () => { engine.update({ wallet: walletView({ mints: [mint(TEST_MINT, 0)] }) }); });
    await user.click(within(dialog).getByTestId("wallet-remove-confirm"));
    expect(engine.callsTo("walletRemove")).toEqual([{ type: "arkade", network: "testnet" }]);
    await waitFor(() => expect(screen.queryByTestId("wallet-remove-dialog")).not.toBeInTheDocument());
    expect(screen.queryByTestId("wallet-card-arkade-testnet")).not.toBeInTheDocument();
    expect(await screen.findByTestId("wallet-card-cashu-testnet")).toHaveAttribute("aria-selected", "true");
  });

  it("a funded Mainnet wallet says how much, offers its backup, and asks in words that the money becomes unreachable", async () => {
    const { user, engine, dialog } = await removing(walletView({ mints: [mint(REAL_MINT, 21_000)], balance: 21_000 }), "cashu-mainnet");
    expect(within(dialog).getByTestId("wallet-remove-network")).toHaveTextContent("Real money");
    expect(within(dialog).getByTestId("wallet-remove-held")).toHaveTextContent("It holds 21,000 sats on Mainnet, real money.");
    // Cashu's backup is its ecash, as tokens.
    engine.on("walletExport", () => [{ mint: REAL_MINT, token: "cashuBfixture", amount: 21_000 }]);
    await user.click(within(dialog).getByTestId("wallet-remove-copy-tokens"));
    expect(engine.callsTo("walletExport")).toEqual([{ network: "mainnet" }]);
    expect(await within(dialog).findByTestId("wallet-remove-notice")).toHaveTextContent("Ecash copied");
    const confirm = within(dialog).getByTestId("wallet-remove-confirm");
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByTestId("wallet-remove-consent")).toHaveTextContent("I understand: these 21,000 sats are real money, and they become unreachable without this wallet's backup.");
    await user.click(within(dialog).getByTestId("wallet-remove-understood"));
    expect(confirm).toBeEnabled();
    engine.on("walletRemove", () => undefined);
    await user.click(confirm);
    expect(engine.callsTo("walletRemove")).toEqual([{ type: "cashu", network: "mainnet", acceptLoss: true }]);
  });

  it("a wallet with a recovery phrase offers it, hidden until asked for, and its backup file", async () => {
    const { user, engine, dialog } = await removing(walletView({ ark: arkReady({ network: "bitcoin", balance: 5_000 }) }), "arkade-mainnet");
    const backup = within(dialog).getByTestId("wallet-remove-backup");
    expect(backup).toHaveTextContent("Recovery phrase");
    expect(backup).toHaveTextContent("Wallet backup");
    expect(backup).not.toHaveTextContent("Restore");
    expect(within(backup).queryByTestId("ark-recovery")).not.toBeInTheDocument();
    engine.on("arkBackup", () => ({ mnemonic: "fixture words only for this test", config: { network: "bitcoin", provider: "https://arkade.computer", explorer: "https://mempool.space/api", walletId: "w", serverKey: "02ab" } }));
    await user.click(within(backup).getByRole("button", { name: "Show" }));
    expect(engine.callsTo("arkBackup")).toEqual([{ network: "mainnet" }]);
    expect(await within(backup).findByTestId("ark-recovery")).toHaveTextContent("fixture words only for this test");
    await user.click(within(backup).getByRole("button", { name: "Hide" }));
    expect(within(backup).queryByTestId("ark-recovery")).not.toBeInTheDocument();
  });

  it("a wallet not connected may hold money: the confirmation says so", async () => {
    const { dialog } = await removing(walletView({ ark: arkReady({ locked: true, balance: 0 }) }), "arkade-testnet");
    expect(within(dialog).getByTestId("wallet-remove-held")).toHaveTextContent("Ghostly cannot read its balance right now (it is not connected): it may hold money.");
    expect(within(dialog).getByTestId("wallet-remove-consent")).toHaveTextContent("whatever this Testnet Ark wallet holds becomes unreachable without its backup");
    expect(within(dialog).getByTestId("wallet-remove-confirm")).toBeDisabled();
  });

  it("a source whose money is elsewhere only forgets the way there: no funds question", async () => {
    const { user, engine, dialog } = await removing(walletView({ mints: [mint(TEST_MINT, 0)], lightning: lightningSource({ mode: "testnet", providerId: "nwc", label: "NWC", alias: "Alby Hub", balance: 800, status: "ready" }) }), "lightning-testnet");
    expect(within(dialog).getByTestId("wallet-remove-held")).toHaveTextContent("Your money stays in Alby Hub: Ghostly only forgets how to reach it.");
    expect(within(dialog).queryByTestId("wallet-remove-understood")).not.toBeInTheDocument();
    engine.on("walletRemove", () => undefined);
    await user.click(within(dialog).getByTestId("wallet-remove-confirm"));
    expect(engine.callsTo("walletRemove")).toEqual([{ type: "lightning", network: "testnet" }]);
  });

  it("Lightning through the mints comes with Cashu: it points there instead of removing on its own", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: walletView({ mints: [mint(TEST_MINT, 0)] }) });
    await user.click(await screen.findByTestId("wallet-card-lightning-testnet"));
    const section = await screen.findByTestId("wallet-remove-section");
    expect(within(section).queryByTestId("wallet-remove")).not.toBeInTheDocument();
    expect(section).toHaveTextContent("This card comes with your Testnet Cashu wallet");
    await user.click(within(section).getByTestId("wallet-remove-open-cashu"));
    expect(screen.getByTestId("wallet-card-cashu-testnet")).toHaveAttribute("aria-selected", "true");
  });

  it("a Mainnet wallet holding nothing that still waits for money lists it, says it is lost afterwards, and asks in words", async () => {
    const wallet = awaitingOn(walletView({ mints: [mint(REAL_MINT, 0)], balance: 0 }), "mainnet", [
      { type: "cashu", kind: "request", amount: 50_000, paymentId: "r1" },
      { type: "cashu", kind: "paid", amount: 700 },
      { type: "cashu", kind: "sent", amount: 21, paymentId: "p1" },
      { type: "arkade", kind: "request", amount: 9, paymentId: "someone-else" },
    ]);
    const { user, engine, dialog } = await removing(wallet, "cashu-mainnet");
    expect(within(dialog).getByTestId("wallet-remove-held")).toHaveTextContent("It holds nothing.");
    expect(within(dialog).getAllByTestId("wallet-remove-awaiting-item").map((i) => [i.dataset.kind, i.textContent])).toEqual([
      ["request", "A request for 50,000 sats in a chat, still open"],
      ["paid", "700 sats paid to an invoice, not claimed from the mint yet"],
    ]);
    expect(within(dialog).getByTestId("wallet-remove-awaiting-note")).toHaveTextContent("Removing the wallet closes its open requests, and your contacts are told. Anything paid to them afterwards is lost: this is real money.");
    expect(within(dialog).getByTestId("wallet-remove-returnable")).toHaveTextContent("Ecash you sent from this wallet has not been taken yet (21 sats). It is not lost: to take it back later, add its mint again first.");
    // Money may still come to it: its backup is offered, and the loss is confirmed in words.
    expect(within(dialog).getByTestId("wallet-remove-backup")).toBeInTheDocument();
    expect(within(dialog).getByTestId("wallet-remove-consent")).toHaveTextContent("I understand: anything paid to its open requests and invoices after it is removed is lost, and it is real money.");
    const confirm = within(dialog).getByTestId("wallet-remove-confirm");
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByTestId("wallet-remove-understood"));
    engine.on("walletRemove", () => undefined);
    await user.click(confirm);
    expect(engine.callsTo("walletRemove")).toEqual([{ type: "cashu", network: "mainnet", acceptLoss: true }]);
  });

  it("in Portuguese, what it holds and waits for is written in Portuguese, amounts too", async () => {
    const wallet = awaitingOn(walletView({ mints: [mint(TEST_MINT, 10_000)], balance: 10_000 }), "testnet", [
      { type: "cashu", kind: "invoice", amount: 2_500 },
      { type: "cashu", kind: "sent", amount: 1_200, paymentId: "p1" },
    ]);
    const { dialog } = await removing(wallet, "cashu-testnet", "pt");
    expect(within(dialog).getByTestId("wallet-remove-held")).toHaveTextContent("10.000 sats de teste");
    expect(within(dialog).getAllByTestId("wallet-remove-awaiting-item").map((i) => i.textContent)).toEqual(["Uma fatura de 2.500 sats de teste, ainda não paga"]);
    expect(within(dialog).getByTestId("wallet-remove-returnable")).toHaveTextContent("1.200 sats de teste");
    expect(within(dialog).getByTestId("wallet-remove-consent")).toHaveTextContent("10.000 sats de teste");
    expect(dialog).not.toHaveTextContent(/test sats|10,000|An invoice/);
  });

  it("a source whose money is elsewhere lists its open requests, which close, and asks nothing about funds", async () => {
    const wallet = awaitingOn(walletView({ mints: [mint(TEST_MINT, 0)], lightning: lightningSource({ mode: "testnet", providerId: "nwc", label: "NWC", alias: "Alby Hub", balance: 800, status: "ready" }) }), "testnet", [{ type: "lightning", kind: "request", amount: 1_000, paymentId: "r1" }]);
    const { dialog } = await removing(wallet, "lightning-testnet");
    expect(within(dialog).getByTestId("wallet-remove-awaiting")).toHaveTextContent("A request for 1,000 test sats in a chat, still open");
    expect(within(dialog).getByTestId("wallet-remove-awaiting-note")).toHaveTextContent("Anything paid to them afterwards still reaches Alby Hub; Ghostly just no longer sees it.");
    expect(within(dialog).queryByTestId("wallet-remove-understood")).not.toBeInTheDocument();
    expect(within(dialog).getByTestId("wallet-remove-confirm")).toBeEnabled();
  });

  it("an unfinished payment stops it", async () => {
    const pending = { id: "p1", method: "arkade", network: "mutinynet", provider: "https://mutinynet.arkade.sh", asset: "BTC", unit: "sat", address: "tark1you", expiresAt: 1, payee: "you", amount: 10, fee: 0, feeCap: 100, createdAt: 1, state: "submitted" } as const;
    const { dialog } = await removing(walletView({ ark: arkReady({ balance: 0 }), intents: [pending] }), "arkade-testnet");
    expect(within(dialog).getByTestId("wallet-remove-pending")).toHaveTextContent("A payment through this wallet is not finished yet (1).");
    expect(within(dialog).getByTestId("wallet-remove-confirm")).toBeDisabled();
  });

  it("what the engine refuses is said once, and the dialog stays", async () => {
    const { user, engine, dialog } = await removing(walletView({ mints: [mint(TEST_MINT, 0)] }), "cashu-testnet");
    engine.on("walletRemove", () => { throw new Error("A Lightning payment from this wallet is still in flight: wait for it to settle, then remove the wallet."); });
    await user.click(within(dialog).getByTestId("wallet-remove-confirm"));
    expect(await within(dialog).findByTestId("wallet-remove-error")).toHaveTextContent("still in flight");
    expect(screen.getAllByTestId("wallet-remove-error")).toHaveLength(1);
    expect(screen.getByTestId("wallet-remove-dialog")).toBeInTheDocument();
  });

  it("Escape and Cancel close it, removing nothing", async () => {
    const { user, engine, dialog } = await removing(walletView({ ark: arkReady({ balance: 0 }) }), "arkade-testnet");
    await user.click(within(dialog).getByTestId("wallet-remove-cancel"));
    expect(screen.queryByTestId("wallet-remove-dialog")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("wallet-remove"));
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("wallet-remove-dialog")).not.toBeInTheDocument();
    expect(engine.callsTo("walletRemove")).toEqual([]);
  });
});

// covers: wallet.instances.remove
describe("Remove, on a mint of the Cashu wallet", () => {
  const OTHER = "https://other.example";

  /** The Wallets page on the Mainnet Cashu card, with these mints. */
  async function cashuWith(mints: MintView[]) {
    const app = renderApp(<Wallet />);
    app.engine.update({ wallet: walletView({ mints }) });
    app.engine.on("walletRemoveMint", () => {}).on("walletRemove", () => {});
    await app.user.click(await screen.findByTestId("wallet-card-cashu-mainnet"));
    const row = (url: string) => screen.getAllByTestId("mint-row").find((r) => r.textContent?.includes(url.replace(/^https?:\/\//, "")))!;
    return { ...app, row };
  }

  it("asks first, and only Remove there removes it; Cancel removes nothing", async () => {
    const { user, engine, row } = await cashuWith([mint(REAL_MINT, 0), mint(OTHER, 0)]);
    await user.click(within(row(OTHER)).getByTestId("mint-remove"));
    const confirm = screen.getByTestId("mint-remove-confirm");
    expect(confirm).toHaveTextContent(`Remove ${OTHER}?`);
    expect(engine.callsTo("walletRemoveMint")).toEqual([]);
    await user.click(within(confirm).getByTestId("mint-remove-cancel"));
    expect(screen.queryByTestId("mint-remove-confirm")).not.toBeInTheDocument();
    expect(engine.callsTo("walletRemoveMint")).toEqual([]);

    await user.click(within(row(OTHER)).getByTestId("mint-remove"));
    await user.click(within(screen.getByTestId("mint-remove-confirm")).getByTestId("mint-remove-yes"));
    expect(engine.callsTo("walletRemoveMint")).toEqual([{ url: OTHER }]);
    await waitFor(() => expect(screen.queryByTestId("mint-remove-confirm")).not.toBeInTheDocument());
  });

  it("a mint that still waits for money says what, and goes only once the person agrees", async () => {
    const waiting = { ...mint(OTHER, 0), awaiting: [{ type: "cashu" as const, kind: "invoice" as const, amount: 2_500 }] };
    const { user, engine, row } = await cashuWith([mint(REAL_MINT, 0), waiting]);
    await user.click(within(row(OTHER)).getByTestId("mint-remove"));
    const confirm = screen.getByTestId("mint-remove-confirm");
    expect(within(confirm).getByTestId("mint-remove-awaiting")).toHaveTextContent("An invoice for 2,500 sats, not paid yet");
    expect(within(confirm).getByTestId("mint-remove-yes")).toBeDisabled();
    await user.click(within(confirm).getByTestId("mint-remove-understood"));
    await user.click(within(confirm).getByTestId("mint-remove-yes"));
    expect(engine.callsTo("walletRemoveMint")).toEqual([{ url: OTHER, acceptLoss: true }]);
  });

  it("the last mint is the wallet: its Remove opens the wallet's removal, which says it removes the wallet", async () => {
    const { user, engine, row } = await cashuWith([mint(REAL_MINT, 0)]);
    await user.click(within(row(REAL_MINT)).getByTestId("mint-remove"));
    const dialog = screen.getByTestId("wallet-remove-dialog");
    expect(within(dialog).getByTestId("wallet-remove-lead")).toHaveTextContent("This is its last mint: removing it removes the Mainnet Cashu wallet and its Lightning card.");
    expect(screen.queryByTestId("mint-remove-confirm")).not.toBeInTheDocument();
    await user.click(within(dialog).getByTestId("wallet-remove-confirm"));
    expect(engine.callsTo("walletRemoveMint")).toEqual([]);
    expect(engine.callsTo("walletRemove")).toEqual([{ type: "cashu", network: "mainnet" }]);
  });
});

// covers: wallet.lightning.cards, wallet.instances.create
describe("a network's Lightning cards", () => {
  /** One Lightning card of Testnet, as the engine lists it. */
  const lnCard = (card: string, name: string, patch: Partial<LightningCardView> = {}): LightningCardView =>
    ({ ...lightningSource({ mode: "testnet", network: "regtest", providerId: "nwc", label: "Nostr Wallet Connect", balance: 5_000, offered: offered("lightning", "testnet") }), card, name, receive: false, ...patch });
  const empty = (): NetworkWalletsView => ({ mints: [], balance: 0, history: [], feesPaid: 0 });
  /** A profile with these Lightning cards on Testnet, and nothing else. */
  function withCards(...cards: LightningCardView[]): WalletView {
    const receiving = cards.find((c) => c.receive) ?? cards[0];
    return walletView({ networks: { mainnet: empty(), testnet: { ...empty(), lightning: receiving, lightnings: cards } } });
  }
  const home = () => lnCard("home", "Home (LND)", { providerId: "lnd", label: "LND node", receive: true, balance: 9_000 });
  const office = () => lnCard("ln-0ff1ce00", "Alby Hub (NWC)", { alias: "Alby Hub", balance: 50 });

  describe("several Lightning cards on a network", () => {
    it("each is a card of its own, named; the default for receiving says so; a network's only one is its Lightning", async () => {
      const { engine } = renderApp(<Wallet />);
      engine.update({ wallet: withCards(home(), office()) });
      const deck = await screen.findByRole("tablist", { name: "Testnet wallets" });
      expect(within(deck).getAllByRole("tab").map((t) => t.dataset.testid)).toEqual(["wallet-card-lightning-testnet-home", "wallet-card-lightning-testnet-ln-0ff1ce00"]);
      const first = screen.getByTestId("wallet-card-lightning-testnet-home"), second = screen.getByTestId("wallet-card-lightning-testnet-ln-0ff1ce00");
      expect(first).toHaveTextContent("Home (LND)");
      expect(within(first).getByTestId("wallet-card-tag")).toHaveTextContent("Default");
      expect(second).toHaveTextContent("Alby Hub (NWC)");
      expect(within(second).queryByTestId("wallet-card-tag")).not.toBeInTheDocument();

      engine.update({ wallet: withCards(home()) });
      expect(await screen.findByTestId("wallet-card-lightning-testnet")).toHaveTextContent("Lightning");
      expect(screen.queryByTestId("wallet-card-tag")).not.toBeInTheDocument();
      expect(screen.queryByTestId("lightning-card")).not.toBeInTheDocument();
    });

    it("a card is made the default and renamed from its own settings; its source is its own (no picker)", async () => {
      const { user, engine } = renderApp(<Wallet />);
      engine.update({ wallet: withCards(home(), office()) });
      engine.on("lightningSetReceive", () => undefined).on("lightningRename", () => undefined);
      await user.click(await screen.findByTestId("wallet-card-lightning-testnet-ln-0ff1ce00"));
      const settings = await screen.findByTestId("lightning-card");
      const toggle = within(settings).getByTestId("lightning-card-default");
      expect(toggle).toHaveAttribute("aria-checked", "false");
      await user.click(toggle);
      expect(engine.callsTo("lightningSetReceive")).toEqual([{ network: "testnet", card: "ln-0ff1ce00" }]);
      const name = within(settings).getByTestId("lightning-card-name");
      await user.clear(name);
      await user.type(name, "Office wallet");
      await user.click(within(settings).getByTestId("lightning-card-rename"));
      expect(engine.callsTo("lightningRename")).toEqual([{ network: "testnet", card: "ln-0ff1ce00", name: "Office wallet" }]);
      expect(screen.queryByTestId("lightning-source-select")).not.toBeInTheDocument();
      expect(screen.getByTestId("lightning-source-current")).toHaveTextContent("Nostr Wallet Connect");

      // The default one shows its switch on, and it cannot be turned off (another card is made the default instead).
      await user.click(screen.getByTestId("wallet-card-lightning-testnet-home"));
      expect(await screen.findByTestId("lightning-card-default")).toHaveAttribute("aria-checked", "true");
      expect(screen.getByTestId("lightning-card-default")).toHaveAttribute("aria-disabled", "true");
    });

    it("Default for receiving and Rename keep the keys while they work, after it and after a refusal; the other waits", async () => {
      const later = () => { let answer!: () => void, refuse!: (e: Error) => void; const promise = new Promise<void>((resolve, reject) => { answer = resolve; refuse = reject; }); return { promise, answer, refuse }; };
      const made = later();
      let renamed = later();
      const { user, engine } = renderApp(<Wallet />);
      engine.update({ wallet: withCards(home(), office()) });
      engine.on("lightningSetReceive", () => made.promise).on("lightningRename", () => renamed.promise);
      await user.click(await screen.findByTestId("wallet-card-lightning-testnet-ln-0ff1ce00"));
      const toggle = await screen.findByTestId("lightning-card-default"), rename = screen.getByTestId("lightning-card-rename"), name = screen.getByTestId("lightning-card-name");

      // The switch, from the keys: busy while it works, then on and unavailable (another card takes it back), still focused.
      toggle.focus();
      await user.keyboard(" ");
      expect(toggle).toHaveAttribute("aria-busy", "true");
      expect(toggle).toBeEnabled();
      expect(toggle).toHaveFocus();
      expect(rename).toBeDisabled();
      made.answer();
      engine.update({ wallet: withCards({ ...home(), receive: false }, { ...office(), receive: true }) });
      await waitFor(() => expect(toggle).not.toHaveAttribute("aria-busy"));
      expect(toggle).toHaveAttribute("aria-checked", "true");
      expect(toggle).toHaveAttribute("aria-disabled", "true");
      expect(toggle).toBeEnabled();
      expect(toggle).toHaveFocus();
      await user.keyboard(" ");
      expect(engine.callsTo("lightningSetReceive")).toHaveLength(1);

      // Rename, unchanged: focusable, its press ignored. Refused: it keeps the focus. Done: unchanged again, still focused.
      rename.focus();
      expect(rename).toHaveAttribute("aria-disabled", "true");
      await user.keyboard("{Enter}");
      expect(engine.callsTo("lightningRename")).toHaveLength(0);
      await user.clear(name);
      await user.type(name, "Office wallet");
      expect(rename).not.toHaveAttribute("aria-disabled");
      rename.focus();
      await user.keyboard("{Enter}");
      expect(rename).toHaveAttribute("aria-busy", "true");
      expect(rename).toBeEnabled();
      expect(rename).toHaveFocus();
      expect(toggle).toBeDisabled();
      renamed.refuse(new Error("That name is taken"));
      expect(await screen.findByTestId("lightning-card-error")).toBeInTheDocument();
      expect(rename).not.toHaveAttribute("aria-busy");
      expect(rename).toHaveFocus();
      renamed = later();
      await user.keyboard("{Enter}");
      expect(rename).toHaveFocus();
      renamed.answer();
      engine.update({ wallet: withCards({ ...home(), receive: false }, { ...office(), name: "Office wallet", receive: true }) });
      await waitFor(() => expect(rename).toHaveAttribute("aria-disabled", "true"));
      expect(rename).not.toHaveAttribute("aria-busy");
      expect(rename).toBeEnabled();
      expect(rename).toHaveFocus();
      expect(engine.callsTo("lightningRename")).toHaveLength(2);
    });

    it("New adds another Lightning card, and brings it to the front, selected", async () => {
      const { user, engine } = renderApp(<Wallet />);
      engine.update({ wallet: withCards(home()) });
      const made: WalletInstanceView = { id: "lightning:testnet:ln-0ff1ce00", type: "lightning", network: "testnet", config: { providerId: "nwc" }, card: "ln-0ff1ce00", name: "Alby Hub (NWC)", receive: false };
      engine.on("walletCreate", () => { engine.update({ wallet: withCards(home(), office()) }); return made; });
      await user.click(await screen.findByTestId("wallet-add"));
      await user.click(screen.getByTestId("new-wallet-network-testnet"));
      expect(screen.getByTestId("new-wallet-type-lightning-status")).toHaveTextContent("Add another…");
      await user.click(screen.getByTestId("new-wallet-type-lightning"));
      const form = await screen.findByTestId("new-wallet-provider");
      await choose(user, within(form).getByRole("combobox", { name: "Source" }), "nwc");
      await user.type(within(form).getByLabelText("Connection URI"), "nostr+walletconnect://office");
      await user.click(within(form).getByTestId("provider-save"));
      expect(engine.callsTo("walletCreate")).toEqual([{ type: "lightning", network: "testnet", providerId: "nwc", values: expect.objectContaining({ uri: "nostr+walletconnect://office" }) }]);
      await waitFor(() => expect(screen.queryByTestId("new-wallet")).not.toBeInTheDocument());
      expect(screen.getByTestId("wallet-card-lightning-testnet-ln-0ff1ce00")).toHaveAttribute("aria-selected", "true");
      expect(screen.getByTestId("wallet-card-lightning-testnet-home")).toHaveAttribute("aria-selected", "false");
    });
  });

  describe("in a chat", () => {
    it("the Pay deck shows each Lightning card; a request on one carries that card's invoice; Accept keeps one Lightning switch", async () => {
      fakeEngine.setState({ links: [linkView()], wallet: withCards(home(), office()) });
      rememberRail("peer", "lightning:testnet:ln-0ff1ce00");
      const onRequest = vi.fn(async () => null);
      const { user } = renderApp(<PaymentComposer balance={0} onSend={vi.fn(async () => null)} onRequest={onRequest} onClose={vi.fn()} reviewContext={reviewContext()} contact="Alice" onSaveMethods={vi.fn(async () => {})} />);
      expect(screen.getAllByRole("radio").map((r) => r.dataset.testid)).toEqual(["payment-card-lightning-testnet-home", "payment-card-lightning-testnet-ln-0ff1ce00"]);
      expect(screen.getByTestId("payment-card-lightning-testnet-ln-0ff1ce00")).toHaveAttribute("aria-checked", "true");
      await user.click(screen.getByTestId("payment-use"));
      await user.type(screen.getByTestId("payment-amount"), "21");
      await user.click(screen.getByTestId("payment-request"));
      expect(onRequest).toHaveBeenCalledWith(21, "", "cashu", "lightning", "testnet", "ln-0ff1ce00");
    });

    it("Accept shows one Lightning card per network: the chat's switch, whatever card receives", async () => {
      fakeEngine.setState({ links: [linkView()], wallet: withCards(home(), office()) });
      const { user } = renderApp(<PaymentComposer balance={0} onSend={vi.fn(async () => null)} onRequest={vi.fn(async () => null)} onClose={vi.fn()} reviewContext={reviewContext()} contact="Alice" onSaveMethods={vi.fn(async () => {})} />);
      await user.click(screen.getByTestId("payment-mode-accept"));
      expect(screen.getAllByRole("switch").map((r) => r.dataset.testid)).toEqual(["payment-accept-lightning-testnet"]);
    });

    it("a contact's request is paid with the card picked: the first eligible one to start with", async () => {
      const invoice = liveRegtestInvoice(250_000);
      const request: Partial<PaymentView> = { kind: "request", direction: "in", amount: 100, invoice, network: "testnet" };
      fakeEngine.setState({ links: [linkView()], wallet: withCards(lnCard("low", "Low (NWC)", { balance: 10, receive: true }), home()), payments: { "pay-1": paymentView(request) } });
      const { user, engine } = renderApp(<PaymentBubble paymentId="pay-1" peerPubKey="peer" fallbackText="[a payment]" />);
      engine.on("walletQuoteInvoice", () => ({ quote: "q-1", mint: "", amount: 100, feeReserve: 3, source: "lnd" })).on("payRequest", () => undefined);
      // The first card that holds enough, not the first card.
      const pick = screen.getByRole("combobox", { name: "Lightning card" });
      expect(pick).toHaveTextContent("Home (LND)");
      await user.click(screen.getByRole("button", { name: "Review payment" }));
      expect(engine.callsTo("walletQuoteInvoice")).toEqual([{ invoice, via: undefined, network: "testnet", card: "home" }]);
      expect(await screen.findByTestId("payment-review")).toHaveTextContent("Through Home (LND)");
      await user.click(screen.getByRole("button", { name: "Approve payment" }));
      expect(engine.callsTo("payRequest")).toEqual([expect.objectContaining({ paymentId: "pay-1", via: "lightning", network: "testnet", card: "home" })]);
    });
  });
});

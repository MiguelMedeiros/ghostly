import { screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkView, WalletView } from "@ghostly/browser/shared/types";
import { PaymentComposer } from "../../components/PaymentComposer";
import { ALL_METHODS_ON, rememberNetwork, rememberRail, startNetwork } from "../../lib/chatPayments";
import { Wallet } from "../../pages/Wallet";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { everyWallet, mint, REAL_MINT, reviewContext, TEST_MINT } from "./fixtures";

// covers: payments.chat.cards, payments.chat.networks, payments.chat.methods

/**
 * The payment sheet's Mainnet | Testnet tabs: each deck (Pay and Accept) shows one network's cards, the tab a chat
 * opens on follows a rule (this chat's last, the contact's one network, real money when there is some), and a network
 * with no wallet leads to New on it. The tab only filters: every card pays on its own network.
 *
 * `everyWallet()` has Cashu, Lightning and Bitcoin on Mainnet, and Ark, Bark, Spark and USDT on Testnet.
 */

beforeEach(() => { document.documentElement.dataset.reduceMotion = "true"; });

/** Cashu (and Lightning through the mints) on both networks, beside the rest. */
const both = () => everyWallet({ mints: [mint(REAL_MINT, 800), mint(TEST_MINT, 800)], balance: 800 });
/** Real money only: Cashu, Lightning and Bitcoin on Mainnet. */
const mainnetOnly = () => everyWallet({ ark: undefined, bark: undefined, spark: undefined, usdt: undefined });
/** Test money only. */
const testnetOnly = () => everyWallet({ mints: [mint(TEST_MINT, 500)], balance: 500, bitcoin: undefined });

function open({ link, wallet = both(), peer = "peer" }: { link?: Partial<LinkView>; wallet?: Partial<WalletView>; peer?: string } = {}) {
  fakeEngine.setState({ links: [linkView({ peerPubKeyZ32: peer, ...link })], wallet });
  const handlers = { onSend: vi.fn(async () => null), onRequest: vi.fn(async () => null), onClose: vi.fn(), onSaveMethods: vi.fn(async () => {}) };
  const view = renderApp(<PaymentComposer balance={1_000} {...handlers} reviewContext={{ ...reviewContext(), peer }} contact="Alice" />);
  return { ...view, ...handlers };
}

const tab = (n: "mainnet" | "testnet") => screen.getByTestId(`payment-tab-${n}`);
const shownTab = () => screen.getByRole("tablist", { name: "Networks" }).querySelector("[aria-selected=true]")?.getAttribute("data-network");
/** The cards the deck shows, Pay's radios or Accept's switches. */
const deck = () => [...screen.getAllByRole("radio"), ...screen.queryAllByRole("switch")].map((c) => c.dataset.testid);

describe("the tabs filter both decks", () => {
  it("shows one network's cards on Pay, and the same network's on Accept", async () => {
    const { user } = open();
    expect(screen.getByRole("tablist", { name: "Networks" })).toBeInTheDocument();
    expect(shownTab()).toBe("mainnet");
    expect(deck()).toEqual(["payment-card-cashu-mainnet", "payment-card-lightning-mainnet", "payment-card-bitcoin-mainnet"]);
    expect(screen.getByTestId("payment-tab-panel")).toHaveAttribute("aria-labelledby", "payment-tab-mainnet");
    await user.click(tab("testnet"));
    expect(deck()).toEqual(["payment-card-cashu-testnet", "payment-card-lightning-testnet", "payment-card-arkade-testnet", "payment-card-bark-testnet", "payment-card-spark-testnet", "payment-card-usdt-testnet"]);
    // Pay starts on the tab's first usable card, and says so.
    expect(screen.getByTestId("payment-card-cashu-testnet")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("payment-use")).toHaveTextContent("Use Cashu");
    await user.click(screen.getByTestId("payment-mode-accept"));
    expect(shownTab()).toBe("testnet");
    expect(screen.getAllByRole("switch").map((c) => c.dataset.testid)).toEqual(["payment-accept-cashu-testnet", "payment-accept-lightning-testnet", "payment-accept-arkade-testnet", "payment-accept-bark-testnet", "payment-accept-spark-testnet", "payment-accept-usdt-testnet"]);
    await user.click(tab("mainnet"));
    expect(screen.getAllByRole("switch").map((c) => c.dataset.testid)).toEqual(["payment-accept-cashu-mainnet", "payment-accept-lightning-mainnet", "payment-accept-bitcoin-mainnet"]);
  });

  it("counts each network's cards in its tab: the ones Pay shows, and every one on Accept", async () => {
    const { user } = open({ link: { paymentMethods: { ...ALL_METHODS_ON, bark: false, spark: false } } });
    expect(screen.getByTestId("payment-tab-mainnet-count")).toHaveTextContent("3");
    expect(screen.getByTestId("payment-tab-testnet-count")).toHaveTextContent("4");
    expect(tab("testnet")).toHaveAccessibleName("Test money, Testnet, 4 wallets");
    await user.click(screen.getByTestId("payment-mode-accept"));
    expect(screen.getByTestId("payment-tab-testnet-count")).toHaveTextContent("6");
  });

  it("looks like the Wallets page's tabs: the same component, each tab naming its money", () => {
    open();
    expect(screen.getByTestId("payment-tabs")).toHaveClass("wallet-networks");
    expect(screen.getByTestId("payment-tabs")).toHaveAttribute("data-size", "compact");
    expect(screen.getByTestId("payment-tab-mainnet-tag")).toHaveTextContent("Real money");
    expect(screen.getByTestId("payment-tab-testnet-tag")).toHaveTextContent("Test money");
  });

  it("pays a card of the tab on its own network, and goes back to that tab from the card", async () => {
    const { user, onRequest } = open();
    await user.click(tab("testnet"));
    await user.click(screen.getByTestId("payment-card-lightning-testnet"));
    await user.click(screen.getByRole("button", { name: "Back to the cards" }));
    await screen.findByRole("radiogroup", { name: "Pay with" });
    expect(shownTab()).toBe("testnet");
    await user.click(screen.getByTestId("payment-card-lightning-testnet"));
    await user.type(screen.getByTestId("payment-amount"), "12");
    await user.click(screen.getByTestId("payment-request"));
    expect(onRequest).toHaveBeenCalledWith(12, "", "cashu", "lightning", "testnet");
  });

  it("keeps the Accept switches of both networks while the tab changes, and saves each on its own", async () => {
    const { user, onSaveMethods } = open();
    await user.click(screen.getByTestId("payment-mode-accept"));
    await user.click(screen.getByTestId("payment-accept-cashu-mainnet"));
    await user.click(tab("testnet"));
    expect(screen.getByTestId("payment-accept-cashu-testnet")).toHaveAttribute("aria-checked", "true");
    await user.click(tab("mainnet"));
    expect(screen.getByTestId("payment-accept-cashu-mainnet")).toHaveAttribute("aria-checked", "false");
    await user.click(screen.getByTestId("payment-accept-save"));
    expect(onSaveMethods).toHaveBeenCalledWith(expect.objectContaining({ networks: expect.objectContaining({ cashu: ["testnet"] }) }));
  });
});

describe("the tab a chat opens on", () => {
  it("is the one this chat used last, and only this chat's", async () => {
    const { user, unmount } = open();
    await user.click(tab("testnet"));
    unmount();
    open();
    expect(shownTab()).toBe("testnet");
  });

  it("is another chat's own: a tab chosen in one chat does not move the next", () => {
    rememberNetwork("peer", "testnet");
    open({ peer: "peer-2" });
    expect(shownTab()).toBe("mainnet");
  });

  it("follows the card used last in this chat", () => {
    rememberRail("peer", "usdt:testnet");
    open();
    expect(shownTab()).toBe("testnet");
    expect(screen.getByTestId("payment-card-usdt-testnet")).toHaveAttribute("aria-checked", "true");
  });

  it("passes over a remembered network with no wallet left on it", () => {
    rememberNetwork("peer", "testnet");
    open({ wallet: mainnetOnly() });
    expect(shownTab()).toBe("mainnet");
  });

  it("is the one network the contact takes, when this chat used none yet", () => {
    open({ link: { dataLink: "open", capabilities: { files: true, payments: true, methods: ALL_METHODS_ON, networks: { cashu: ["testnet"], lightning: ["testnet"] } } } });
    expect(shownTab()).toBe("testnet");
  });

  it("is real money when the contact takes both, and when the chat is not connected", () => {
    open({ link: { dataLink: "open", capabilities: { files: true, payments: true, methods: ALL_METHODS_ON, networks: { cashu: ["mainnet", "testnet"] } } } });
    expect(shownTab()).toBe("mainnet");
  });

  it("is Testnet when this profile has test money only", () => {
    open({ wallet: testnetOnly() });
    expect(shownTab()).toBe("testnet");
    expect(screen.getByTestId("payment-card-cashu-testnet")).toHaveAttribute("aria-checked", "true");
  });

  it("follows the rule step by step", () => {
    const cards = [{ rail: "cashu", network: "mainnet" as const }, { rail: "arkade", network: "testnet" as const }];
    expect(startNetwork("c1", cards)).toBe("mainnet");
    expect(startNetwork("c1", [cards[1]])).toBe("testnet");
    // The contact's one network, among yours; a way it has off does not count.
    expect(startNetwork("c1", cards, { arkade: ["testnet"] })).toBe("testnet");
    expect(startNetwork("c1", cards, { arkade: ["testnet"], cashu: ["mainnet"] }, { cashu: false })).toBe("testnet");
    expect(startNetwork("c1", cards, { arkade: ["testnet"], cashu: ["mainnet"] })).toBe("mainnet");
    // A rail from before networks: that rail's card's network.
    rememberRail("c1", "arkade");
    expect(startNetwork("c1", cards)).toBe("testnet");
    // The tab chosen last wins over the card, and the contact.
    rememberNetwork("c1", "mainnet");
    expect(startNetwork("c1", cards, { arkade: ["testnet"] })).toBe("mainnet");
  });
});

describe("a network with no wallet", () => {
  it("says so, and leads to New on that network", async () => {
    fakeEngine.setState({ links: [linkView()], wallet: mainnetOnly() });
    const onClose = vi.fn();
    const { user } = renderApp(
      <Routes>
        <Route path="/" element={<PaymentComposer balance={1_000} onSend={async () => null} onRequest={async () => null} onClose={onClose} reviewContext={reviewContext()} contact="Alice" onSaveMethods={async () => {}} />} />
        <Route path="/wallet" element={<Wallet />} />
      </Routes>,
    );
    await user.click(tab("testnet"));
    const empty = screen.getByTestId("payment-network-empty");
    expect(empty).toHaveTextContent("No Testnet wallets");
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.queryByTestId("payment-use")).not.toBeInTheDocument();
    // Accept too: nothing to switch on here, the same way out.
    await user.click(screen.getByTestId("payment-mode-accept"));
    expect(screen.getByTestId("payment-network-empty")).toBeInTheDocument();
    await user.click(within(screen.getByTestId("payment-network-empty")).getByTestId("payment-network-new"));
    expect(onClose).toHaveBeenCalled();
    // The Wallets page, with New open on Testnet.
    const dialog = await screen.findByTestId("new-wallet");
    expect(within(dialog).getByTestId("new-wallet-network")).toHaveAttribute("data-network", "testnet");
  });
});

describe("Accept on a network with no wallet", () => {
  it("keeps what was switched on the other tab, and Save stays in reach to save it", async () => {
    const { user, onSaveMethods } = open({ wallet: testnetOnly() });
    await user.click(screen.getByTestId("payment-mode-accept"));
    await user.click(screen.getByTestId("payment-accept-lightning-testnet"));
    await user.click(tab("mainnet"));
    expect(screen.getByTestId("payment-network-empty")).toBeInTheDocument();
    expect(screen.getByTestId("payment-accept-status")).toHaveAttribute("data-state", "changed");
    await user.click(tab("testnet"));
    expect(screen.getByTestId("payment-accept-lightning-testnet")).toHaveAttribute("aria-checked", "false");
    await user.click(tab("mainnet"));
    await user.click(screen.getByTestId("payment-accept-save"));
    expect(onSaveMethods).toHaveBeenCalledWith(expect.objectContaining({ methods: expect.objectContaining({ lightning: false }) }));
  });

  it("says only that there is none when nothing waits to be saved", async () => {
    const { user } = open({ wallet: testnetOnly() });
    await user.click(screen.getByTestId("payment-mode-accept"));
    await user.click(tab("mainnet"));
    expect(screen.getByTestId("payment-network-empty")).toHaveTextContent("No Mainnet wallets");
    expect(screen.queryByTestId("payment-accept-save")).not.toBeInTheDocument();
    expect(screen.queryByTestId("payment-accept-status")).not.toBeInTheDocument();
  });
});

describe("the keyboard", () => {
  it("moves between the networks with the arrows, Home and End, choosing as it goes", async () => {
    const { user } = open();
    tab("mainnet").focus();
    await user.keyboard("{ArrowRight}");
    expect(tab("testnet")).toHaveFocus();
    expect(tab("testnet")).toHaveAttribute("aria-selected", "true");
    expect(tab("testnet")).toHaveAttribute("tabindex", "0");
    expect(tab("mainnet")).toHaveAttribute("tabindex", "-1");
    expect(screen.getByTestId("payment-card-cashu-testnet")).toBeInTheDocument();
    await user.keyboard("{Home}");
    expect(tab("mainnet")).toHaveFocus();
    expect(shownTab()).toBe("mainnet");
    await user.keyboard("{End}");
    expect(tab("testnet")).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(tab("mainnet")).toHaveFocus();
    expect(screen.getByTestId("payment-card-cashu-mainnet")).toBeInTheDocument();
  });

  it("leaves Pay or Request | Accept to its own arrows", async () => {
    const { user } = open();
    screen.getByTestId("payment-mode-pay").focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByTestId("payment-mode-accept")).toHaveFocus();
    expect(shownTab()).toBe("mainnet");
  });
});

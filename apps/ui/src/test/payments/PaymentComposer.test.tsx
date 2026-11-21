import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Language } from "../../lib/settings";
import type { LinkView, WalletInstanceView, WalletView } from "@ghostly/browser/shared/types";
import { engineText, type WalletNetwork } from "@ghostly/core";
import { MessageInput } from "../../components/MessageInput";
import { PaymentComposer } from "../../components/PaymentComposer";
import { FLIP_MS } from "../../components/deck/useCardFlip";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { ALL_METHODS_ON, rememberNetwork, rememberRail, rememberedRail, startNetwork } from "../../lib/chatPayments";
import { Wallet } from "../../pages/Wallet";
import { fakeEngine, linkView, paymentView } from "../fakeEngine";
import { renderApp } from "../render";
import { arkReady, bitcoinSource, everyWallet, lightningSource, mint, REAL_MINT, reviewContext, reviewOf, target, TEST_MINT, usdtReady } from "./fixtures";

// covers: payments.chat.cards, payments.chat.methods, payments.chat.networks, wallet.instances.sections, payments.amounts, payments.cashu.send, payments.arkade.send, payments.bark.send, payments.bitcoin.send, payments.usdt.send

const OTHER_MINT = "https://mint2.example.com";
const ALL_ON = { cashu: true, lightning: true, arkade: true, bark: true, spark: true, bitcoin: true, usdt: true, fedimint: true };

/**
 * `everyWallet()` gives one wallet per type, each on the network of its own chain: Cashu, Lightning (through the
 * real mint) and on-chain Bitcoin on Mainnet; Ark (Mutinynet), Bark (signet), Spark (regtest) and USDT (Sepolia) on
 * Testnet.
 */
interface Open {
  wallet?: Partial<WalletView>;
  link?: Partial<LinkView>;
  balance?: number;
  /** Without it the composer has no wallet of its own: only the back, and Send goes through `onSend`. */
  withWallet?: boolean;
  onSend?: (amount: number, memo: string, network?: WalletNetwork, confirmedReal?: boolean) => Promise<string | null>;
  onRequest?: (amount: number, memo: string, method?: string, rail?: string, network?: WalletNetwork) => Promise<string | null>;
  language?: Language;
}

/** Where the app is: the composer navigates away to make a wallet. */
function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

/** The composer in a chat with "peer", whose name the chat shows as Alice. */
function open({ wallet = everyWallet(), link, balance = 1_000, withWallet = true, onSend, onRequest, language }: Open = {}) {
  // The chat and the wallet are there before the composer opens, as they are in the app.
  fakeEngine.setState({ links: [linkView(link)], wallet });
  const handlers = {
    onSend: vi.fn(onSend ?? (async () => null)),
    onRequest: vi.fn(onRequest ?? (async () => null)),
    onClose: vi.fn(),
  };
  const view = renderApp(
    <><PaymentComposer balance={balance} {...handlers} reviewContext={withWallet ? reviewContext() : undefined} contact="Alice" /><Where /></>,
    { language },
  );
  return { ...view, ...handlers };
}

/** A wallet the profile has, as the engine lists it: a test gives these when the flat fields would not make it. */
const instance = (type: WalletInstanceView["type"], network: WalletNetwork): WalletInstanceView => ({ id: `${type}:${network}`, type, network, config: {} });

const amount = () => screen.getByTestId("payment-amount");
const send = () => screen.getByTestId("payment-send");
const request = () => screen.getByTestId("payment-request");
/** A card by its type and network: `card("cashu-mainnet")`. */
const card = (id: string) => screen.getByTestId(`payment-card-${id}`);
const hint = () => screen.getByText((_, el) => !!el?.classList.contains("payment-back-hint"));
/** The card back's line under its name: what it holds, and whom with. */
const meta = () => screen.getByTestId("payment-back").querySelector(".payment-back-meta");
/** The sheet's Mainnet | Testnet tab. */
const tab = (network: WalletNetwork) => screen.getByTestId(`payment-tab-${network}`);
/** The ids of the cards the deck shows. */
const deck = () => screen.getAllByRole("radio").map((r) => r.dataset.testid);

describe("the amount", () => {
  it("keeps digits and separators in an amount of sats, and refuses a fraction of a sat instead of reading 12.5 as 125", async () => {
    const { user } = open({ withWallet: false });
    await user.type(amount(), "1a2.5b");
    expect(amount()).toHaveValue("12.5");
    expect(amount()).toHaveAccessibleName("Amount in sats");
    expect(screen.getByTestId("amount-unclear")).toHaveTextContent("Whole numbers only, like 1,234");
    expect(request()).toBeDisabled();
  });

  it("takes decimals for USDT and requests in the token's smallest units, on the card's network", async () => {
    rememberRail("peer", "usdt:testnet");
    const { user, onRequest } = open();
    await user.click(screen.getByTestId("payment-use"));
    await user.type(amount(), "1.5x");
    expect(amount()).toHaveValue("1.5");
    await user.type(screen.getByRole("textbox", { name: "What for? (optional)" }), "coffee");
    await user.click(request());
    expect(onRequest).toHaveBeenCalledWith(1_500_000, "coffee", "usdt", "usdt", "testnet");
  });

  it("takes a comma as the decimal point where the language writes one (a phone's decimal key types it)", async () => {
    rememberRail("peer", "usdt:testnet");
    const { user, onRequest } = open({ language: "pt" });
    await user.click(screen.getByTestId("payment-use"));
    await user.type(amount(), "1.000,5");
    expect(amount()).toHaveValue("1.000,5");
    await user.clear(amount());
    await user.type(amount(), "1,5");
    expect(amount()).toHaveValue("1,5");
    await user.click(request());
    expect(onRequest).toHaveBeenCalledWith(1_500_000, "", "usdt", "usdt", "testnet");
  });

  it("reads a comma as grouping in a language that writes the point", async () => {
    rememberRail("peer", "usdt:testnet");
    const { user, onRequest } = open();
    await user.click(screen.getByTestId("payment-use"));
    await user.type(amount(), "1,000.5");
    expect(amount()).toHaveValue("1,000.5");
    await user.click(request());
    expect(onRequest).toHaveBeenCalledWith(1_000_500_000, "", "usdt", "usdt", "testnet");
  });

  it("reads \"1.000\" in Portuguese as a thousand, and refuses \"1.5\" there rather than guess", async () => {
    rememberRail("peer", "usdt:testnet");
    const { user, onRequest } = open({ language: "pt" });
    await user.click(screen.getByTestId("payment-use"));
    await user.type(amount(), "1.000");
    await user.click(request());
    expect(onRequest).toHaveBeenCalledWith(1_000_000_000, "", "usdt", "usdt", "testnet");
    onRequest.mockClear();
    await user.clear(amount());
    await user.type(amount(), "1.5");
    expect(screen.getByTestId("amount-unclear")).toHaveTextContent("Valor ambíguo");
    expect(request()).toBeDisabled();
    expect(onRequest).not.toHaveBeenCalled();
  });

  it("refuses more USDT decimals than the token has, without asking for anything", async () => {
    rememberRail("peer", "usdt:testnet");
    const { user, onRequest } = open();
    await user.click(screen.getByTestId("payment-use"));
    await user.type(amount(), "1.1234567");
    await user.click(request());
    expect(await screen.findByRole("alert")).toHaveTextContent("Use at most 6 decimal places");
    expect(onRequest).not.toHaveBeenCalled();
  });

  it.each([
    ["Cashu on Mainnet", "cashu:mainnet", {}, "sats"],
    ["Cashu on Testnet", "cashu:testnet", { mints: [mint(TEST_MINT, 1_000)] }, "test sats"],
    ["Lightning on Testnet", "lightning:testnet", { mints: [mint(TEST_MINT, 1_000)] }, "test sats"],
    ["Ark on Mutinynet", "arkade:testnet", { ark: arkReady({ network: "mutinynet" }) }, "test sats"],
    ["Ark on Bitcoin", "arkade:mainnet", { ark: arkReady({ network: "bitcoin" }) }, "sats"],
    ["Bark on signet", "bark:testnet", {}, "test sats"],
    ["on-chain on regtest", "bitcoin:testnet", { bitcoin: bitcoinSource({ mode: "testnet", network: "regtest" }) }, "test sats"],
    ["on-chain on Bitcoin", "bitcoin:mainnet", { bitcoin: bitcoinSource({ network: "bitcoin" }) }, "sats"],
    ["USDT on Sepolia", "usdt:testnet", { usdt: usdtReady({ chainId: 11155111 }) }, "TEST-USDT"],
    ["USDT on Ethereum", "usdt:mainnet", { usdt: usdtReady({ chainId: 1 }) }, "USDT"],
  ])("counts %s in the right unit", async (_, id, wallet, unit) => {
    rememberRail("peer", id);
    const { user } = open({ wallet: everyWallet(wallet) });
    await user.click(screen.getByTestId("payment-use"));
    expect(screen.getByTestId("payment-back")).toHaveAttribute("data-network", id.split(":")[1]);
    expect(amount()).toHaveAccessibleName(`Amount in ${unit}`);
  });
});

describe("the cards", () => {
  it("starts on the Mainnet Cashu card when no card was used before", () => {
    open();
    expect(screen.getByRole("radiogroup", { name: "Pay with" })).toBeInTheDocument();
    expect(card("cashu-mainnet")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("payment-use")).toHaveTextContent("Use Cashu");
  });

  it("shows one network's cards at a time, each card on its own network", async () => {
    const { user } = open();
    // Real money first: the deck shows Mainnet's cards, and the other network is a tab away, never mixed in.
    expect(tab("mainnet")).toHaveAttribute("aria-selected", "true");
    expect(deck()).toEqual(["payment-card-cashu-mainnet", "payment-card-lightning-mainnet", "payment-card-bitcoin-mainnet"]);
    // Every card says its network here, Mainnet too.
    expect(screen.getByTestId("payment-card-bitcoin-mainnet").querySelector("[data-testid=wallet-card-network]")).toHaveTextContent("Mainnet");
    await user.click(tab("testnet"));
    expect(deck()).toEqual(["payment-card-arkade-testnet", "payment-card-bark-testnet", "payment-card-spark-testnet", "payment-card-usdt-testnet"]);
    expect(screen.getByTestId("payment-card-usdt-testnet").querySelector("[data-testid=wallet-card-network]")).toHaveTextContent("Testnet");
  });

  it("shows a shared balance's number on one card only: Lightning through the mints says it uses Cashu's, its back keeps the amount", async () => {
    const { user } = open();
    expect(card("cashu-mainnet")).toHaveTextContent("1,000 sats");
    expect(card("lightning-mainnet")).toHaveTextContent("Uses your Cashu balance");
    expect(card("lightning-mainnet")).not.toHaveTextContent("1,000");
    await user.click(card("lightning-mainnet"));
    // Turned over, it is the only card shown: what it can spend, as before.
    expect(meta()).toHaveTextContent("1,000 sats · with Alice");
  });

  it("starts on the card used last time, on its network's tab", () => {
    rememberRail("peer", "arkade:testnet");
    open();
    expect(tab("testnet")).toHaveAttribute("aria-selected", "true");
    expect(card("arkade-testnet")).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByTestId("payment-card-cashu-mainnet")).not.toBeInTheDocument();
  });

  it("reads a remembered rail from before networks as that rail's first card", () => {
    // Both networks have a Cashu card: the old value "cashu" picks the first one, in the deck's order.
    rememberRail("peer", "cashu");
    open({ wallet: everyWallet({ mints: [mint(REAL_MINT, 500), mint(TEST_MINT, 500)], balance: 500 }) });
    expect(tab("mainnet")).toHaveAttribute("aria-selected", "true");
    expect(card("cashu-mainnet")).toHaveAttribute("aria-checked", "true");
  });

  it("reads a remembered old rail as its card on whichever network it is", () => {
    rememberRail("peer", "arkade");
    open();
    expect(tab("testnet")).toHaveAttribute("aria-selected", "true");
    expect(card("arkade-testnet")).toHaveAttribute("aria-checked", "true");
  });

  it("skips a remembered card that is off in this chat, for the first one on its network that is on", () => {
    rememberRail("peer", "arkade:testnet");
    open({ link: { paymentMethods: { ...ALL_ON, cashu: false, arkade: false } } });
    expect(card("bark-testnet")).toHaveAttribute("aria-checked", "true");
  });

  it("starts on the first card that can be used, in the deck's order, not on one that is not set up", async () => {
    // A Cashu wallet with no mint: Cashu and Lightning (through the mints) cannot be used, and they are all Mainnet has.
    const { user } = open({ wallet: everyWallet({ mints: [], balance: 0, wallets: [instance("cashu", "mainnet"), instance("lightning", "mainnet"), instance("arkade", "testnet"), instance("bark", "testnet")] }) });
    expect(screen.getByTestId("payment-use")).toBeDisabled();
    await user.click(tab("testnet"));
    expect(card("arkade-testnet")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("payment-use")).toBeEnabled();
  });

  it("passes over a remembered card that cannot be used now", () => {
    rememberRail("peer", "usdt:mainnet");
    open({ wallet: everyWallet({ usdt: { configured: true, locked: true, chainId: 1, decimals: 6, balance: "0", gasBalance: "0" } }) });
    expect(card("usdt-mainnet")).toHaveAttribute("aria-disabled", "true");
    expect(card("cashu-mainnet")).toHaveAttribute("aria-checked", "true");
  });

  it("starts past a card the contact does not accept", () => {
    open({ link: { dataLink: "open", capabilities: { files: true, payments: true, methods: { ...ALL_ON, cashu: false } } } });
    expect(card("lightning-mainnet")).toHaveAttribute("aria-checked", "true");
  });

  it("moves to the first card that can be used as the wallet comes up, until one is picked", async () => {
    // An Ark wallet whose provider has not answered, after a Bark one that is not set up.
    rememberNetwork("peer", "testnet");
    open({ wallet: everyWallet({ ark: undefined, bark: undefined, wallets: [instance("cashu", "mainnet"), instance("bark", "testnet"), instance("arkade", "testnet")] }) });
    expect(card("bark-testnet")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("payment-use")).toBeDisabled();
    act(() => fakeEngine.update({ wallet: { ...fakeEngine.state.wallet, ark: arkReady() } }));
    await waitFor(() => expect(screen.getByTestId("payment-use")).toHaveTextContent("Use Ark"));
    expect(card("arkade-testnet")).toHaveAttribute("aria-checked", "true");
  });

  it("ignores a remembered value that is not a card", () => {
    rememberRail("peer", "paypal");
    open();
    expect(card("cashu-mainnet")).toHaveAttribute("aria-checked", "true");
  });

  it("turns over the card clicked, names its network on the back and remembers the wallet for next time", async () => {
    rememberNetwork("peer", "testnet");
    const { user } = open();
    await user.click(card("arkade-testnet"));
    expect(rememberedRail("peer")).toBe("arkade:testnet");
    const back = screen.getByTestId("payment-back");
    expect(back).toHaveAttribute("data-network", "testnet");
    expect(screen.getByTestId("payment-composer")).toHaveAttribute("data-network", "testnet");
    expect(within(back).getByText("Ark · Testnet")).toBeInTheDocument();
    expect(within(back).getByTestId("payment-back-network")).toHaveTextContent("Test money");
    expect(meta()).toHaveTextContent("5,000 test sats · with Alice");
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });

  it("names a Mainnet card on the back by its name alone", async () => {
    const { user } = open();
    await user.click(card("cashu-mainnet"));
    const back = screen.getByTestId("payment-back");
    expect(back).toHaveAttribute("data-network", "mainnet");
    expect(within(back).getByText("Cashu")).toBeInTheDocument();
    expect(within(back).getByTestId("payment-back-network")).toHaveTextContent("Real money");
    expect(meta()).toHaveTextContent("1,000 sats · with Alice");
  });

  it("moves along the cards with the arrow keys and turns the chosen one over with Enter", async () => {
    const { user } = open();
    // The keyboard starts on the chosen card.
    expect(card("cashu-mainnet")).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(card("lightning-mainnet")).toHaveAttribute("aria-checked", "true");
    expect(card("lightning-mainnet")).toHaveFocus();
    // Moving only selects: nothing is remembered until a card is turned over.
    expect(rememberedRail("peer")).toBeNull();
    await user.keyboard("{Enter}");
    expect(within(screen.getByTestId("payment-back")).getByText("Lightning")).toBeInTheDocument();
    expect(rememberedRail("peer")).toBe("lightning:mainnet");
  });

  it("goes back from the amount to the cards with the Cards button in the card's top-left corner", async () => {
    rememberNetwork("peer", "testnet");
    document.documentElement.dataset.reduceMotion = "true";
    const { user, onClose } = open();
    await user.click(card("arkade-testnet"));
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    const cards = screen.getByRole("button", { name: "Cards" });
    expect(cards).toHaveAccessibleDescription("Back to the cards");
    // It leads the card's head, before the mark and the name: where a way back is looked for.
    expect(cards.parentElement!.firstElementChild).toBe(cards);
    await user.click(cards);
    expect(await screen.findByRole("radiogroup", { name: "Pay with" })).toBeInTheDocument();
    // The keyboard is back on the card that was turned over, which is still the chosen one.
    expect(card("arkade-testnet")).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(card("arkade-testnet")).toHaveFocus());
    expect(onClose).not.toHaveBeenCalled();
    // And another card turns over from there.
    await user.click(card("usdt-testnet"));
    expect(within(screen.getByTestId("payment-back")).getByText("USDT · Testnet")).toBeInTheDocument();
  });

  it("steps back on Escape: from a turned card to the cards, and only then closes", async () => {
    rememberNetwork("peer", "testnet");
    document.documentElement.dataset.reduceMotion = "true";
    const { user, onClose } = open();
    await user.click(card("arkade-testnet"));
    await waitFor(() => expect(amount()).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(await screen.findByRole("radiogroup", { name: "Pay with" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(card("arkade-testnet")).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("steps back on Escape while the card is still turning over, and closes on one while it turns back", async () => {
    rememberNetwork("peer", "testnet");
    document.documentElement.dataset.reduceMotion = "true";
    const { user, onClose } = open();
    await user.click(card("arkade-testnet"));
    // No wait for the turn to end: the Escape is for the card being chosen, not for the sheet.
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(await screen.findByRole("radiogroup", { name: "Pay with" })).toBeInTheDocument();
    await user.click(card("arkade-testnet"));
    await user.click(screen.getByRole("button", { name: "Cards" }));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("steps back on Escape wherever the focus is, a click on the card's text having left it on the page", async () => {
    rememberNetwork("peer", "testnet");
    document.documentElement.dataset.reduceMotion = "true";
    const { user, onClose } = open();
    await user.click(card("arkade-testnet"));
    await user.click(hint());
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard("{Escape}");
    expect(await screen.findByRole("radiogroup", { name: "Pay with" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  // Escape drops an input method's candidate (Japanese, Chinese, Korean…): Chromium sends it while composing, WebKit
  // right after the composition ended, as 229. It turned the card back, or closed the sheet, with the memo typed so far.
  it("leaves an input method's Escape in the memo alone: the card stays turned, the sheet open", async () => {
    rememberNetwork("peer", "testnet");
    document.documentElement.dataset.reduceMotion = "true";
    const { user, onClose } = open();
    await user.click(card("arkade-testnet"));
    await waitFor(() => expect(amount()).toHaveFocus());
    const memo = screen.getByRole("textbox", { name: "What for? (optional)" });
    memo.focus();
    fireEvent.compositionStart(memo);
    fireEvent.keyDown(memo, { key: "Escape", isComposing: true });
    fireEvent.compositionEnd(memo, { data: "" });
    fireEvent.keyDown(memo, { key: "Escape", keyCode: 229 });
    await act(async () => {});
    expect(screen.queryByRole("radiogroup", { name: "Pay with" })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(await screen.findByRole("radiogroup", { name: "Pay with" })).toBeInTheDocument();
  });

  it("never closes on a click inside, on the cards or on a turned card", async () => {
    rememberNetwork("peer", "testnet");
    document.documentElement.dataset.reduceMotion = "true";
    const { user, onClose } = open();
    await user.click(screen.getByText("Pay or request"));
    await user.click(card("arkade-testnet"));
    await user.click(hint());
    await user.click(screen.getByTestId("payment-back"));
    await user.click(screen.getByRole("button", { name: "Cards" }));
    await screen.findByRole("radiogroup", { name: "Pay with" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on a click outside", async () => {
    const { user, onClose } = open();
    await user.click(screen.getByTestId("where"));
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape", async () => {
    const { user, onClose } = open();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("a profile with no wallet", () => {
  it("offers to create one, and goes to the wallet page to do it", async () => {
    const { user, onClose } = open({ wallet: {} });
    expect(screen.getByTestId("payment-no-wallet")).toHaveTextContent("You have no wallet yet.");
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.queryByTestId("payment-amount")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("payment-no-wallet-create"));
    expect(onClose).toHaveBeenCalled();
    expect(await screen.findByText("/wallet")).toBeInTheDocument();
  });
});

describe("a card that cannot be used here", () => {
  it("says a wallet that is not ready yet is still connecting, and is not turned over", async () => {
    rememberNetwork("peer", "testnet");
    const { user } = open({ wallet: everyWallet({ ark: arkReady({ address: undefined, automatic: true }) }) });
    expect(card("arkade-testnet")).toHaveAttribute("aria-disabled", "true");
    expect(card("arkade-testnet")).toHaveAttribute("title", "Ark is connecting…");
    await user.click(card("arkade-testnet"));
    // It comes up, to say why, but stays a card.
    expect(card("arkade-testnet")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Ark is connecting…", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByTestId("payment-use")).toBeDisabled();
    expect(rememberedRail("peer")).toBeNull();
  });

  it("says a way of paying is off in this chat, naming the card's network", () => {
    rememberNetwork("peer", "testnet");
    open({ link: { paymentMethods: { ...ALL_ON, bark: false } } });
    expect(card("bark-testnet")).toHaveAttribute("title", "Testnet Bark is off in this chat");
    expect(within(card("bark-testnet")).getByText("Off here")).toBeInTheDocument();
  });

  it("says a card is off when this chat takes its way of paying on the other network only", () => {
    open({ link: { paymentNetworks: { ...Object.fromEntries(Object.keys(ALL_ON).map((m) => [m, ["mainnet", "testnet"]])), cashu: ["testnet"] } as LinkView["paymentNetworks"] } });
    expect(card("cashu-mainnet")).toHaveAttribute("title", "Mainnet Cashu is off in this chat");
    expect(card("lightning-mainnet")).not.toHaveAttribute("aria-disabled");
  });

  it("says the contact does not accept a way of paying", () => {
    rememberNetwork("peer", "testnet");
    open({ link: { dataLink: "open", capabilities: { files: true, payments: true, methods: { ...ALL_ON, usdt: false } } } });
    expect(card("usdt-testnet")).toHaveAttribute("title", "Your contact does not accept USDT in this chat");
    expect(within(card("usdt-testnet")).getByText("Not accepted")).toBeInTheDocument();
  });

  it("does not hold what the contact accepts against them while the chat is not connected", () => {
    rememberNetwork("peer", "testnet");
    open({ link: { dataLink: "idle", capabilities: { files: true, payments: true, methods: { ...ALL_ON, usdt: false } } } });
    expect(card("usdt-testnet")).not.toHaveAttribute("aria-disabled");
  });

  describe("when the contact has no wallet of the card's network", () => {
    // Alice has Cashu on Mainnet only: a test sat must not go to her, nor be asked of her.
    const theirs = { cashu: ["mainnet"], lightning: ["mainnet"] } as const;
    const testCashu = () => everyWallet({ mints: [mint(TEST_MINT, 500)], balance: 500 });

    it("blocks the card and says which wallet the contact lacks", async () => {
      rememberNetwork("peer", "testnet");
      const { user } = open({ wallet: testCashu(), link: { dataLink: "open", capabilities: { files: true, payments: true, methods: ALL_ON, networks: theirs } } });
      expect(card("cashu-testnet")).toHaveAttribute("aria-disabled", "true");
      expect(card("cashu-testnet")).toHaveAttribute("title", "Your contact has no Testnet Cashu wallet");
      expect(within(card("cashu-testnet")).getByText("Not accepted")).toBeInTheDocument();
      await user.click(card("cashu-testnet"));
      expect(screen.getByText("Your contact has no Testnet Cashu wallet", { selector: "p" })).toBeInTheDocument();
      expect(screen.getByTestId("payment-use")).toBeDisabled();
    });

    it("still offers the card the contact has a wallet for", () => {
      open({ wallet: everyWallet(), link: { dataLink: "open", capabilities: { files: true, payments: true, methods: ALL_ON, networks: theirs } } });
      expect(card("cashu-mainnet")).not.toHaveAttribute("aria-disabled");
      expect(card("cashu-mainnet")).toHaveAttribute("aria-checked", "true");
    });

    it("does not hold it against them while the chat is not connected", () => {
      rememberNetwork("peer", "testnet");
      open({ wallet: testCashu(), link: { dataLink: "idle", capabilities: { files: true, payments: true, methods: ALL_ON, networks: theirs } } });
      expect(card("cashu-testnet")).not.toHaveAttribute("aria-disabled");
    });

    it("lets every network meet when the contact said none (an older app)", () => {
      rememberNetwork("peer", "testnet");
      open({ wallet: testCashu(), link: { dataLink: "open", capabilities: { files: true, payments: true, methods: ALL_ON } } });
      expect(card("cashu-testnet")).not.toHaveAttribute("aria-disabled");
    });
  });
});

describe("request and send", () => {
  it("requests with a Lightning invoice but sends nothing on Lightning", async () => {
    rememberRail("peer", "lightning:mainnet");
    const { user, onRequest, onClose } = open();
    await user.click(screen.getByTestId("payment-use"));
    await user.type(amount(), "50");
    expect(send()).toBeDisabled();
    expect(send()).toHaveAttribute("title", "To pay on this card, tap Pay on your contact's request");
    await user.click(request());
    // A Lightning request is a Cashu request: it carries the invoice.
    // The card rides along: a chat ignores it, a group asks for that rail only. So does its network.
    expect(onRequest).toHaveBeenCalledWith(50, "", "cashu", "lightning", "mainnet");
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps Request and Send off until there is an amount", () => {
    open({ withWallet: false });
    expect(request()).toBeDisabled();
    expect(send()).toBeDisabled();
  });

  it("warns when the amount is more than the card holds, and only Request stays on", async () => {
    const { user } = open({ withWallet: false, balance: 100 });
    await user.type(amount(), "150");
    expect(hint()).toHaveTextContent("More than the 100 sats on this card.");
    expect(send()).toBeDisabled();
    expect(request()).toBeEnabled();
  });

  it("measures an Ark amount against the Ark balance", async () => {
    rememberRail("peer", "arkade:testnet");
    const { user } = open({ balance: 1_000_000 });
    await user.click(screen.getByTestId("payment-use"));
    await user.type(amount(), "6000");
    expect(hint()).toHaveTextContent("More than the 5,000 test sats on this card.");
    expect(send()).toBeDisabled();
  });

  it("with no wallet to review it with, sends ecash once confirmed as real money (no card: Mainnet)", async () => {
    const { user, onSend, onClose } = open({ withWallet: false });
    await user.type(amount(), "21");
    await user.type(screen.getByRole("textbox", { name: "What for? (optional)" }), "tip");
    await user.click(send());
    expect(screen.getByTestId("review-mainnet-confirm")).toHaveTextContent("Real money. This sends 21 sats");
    expect(onSend).not.toHaveBeenCalled();
    // Another amount asks again: what the step names is what it sends.
    await user.type(amount(), "0");
    expect(screen.queryByTestId("review-mainnet-confirm")).not.toBeInTheDocument();
    await user.click(send());
    await user.click(screen.getByTestId("review-confirm-send"));
    // No card, so no network: the engine sends from the wallet it would.
    expect(onSend).toHaveBeenCalledWith(210, "tip", undefined, true);
    expect(onClose).toHaveBeenCalled();
  });

  it("Back on the real-money step from the keyboard puts the keys back on Send, not on the page", async () => {
    const { user, onSend } = open({ withWallet: false });
    await user.type(amount(), "21");
    send().focus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("review-confirm-back")).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("review-mainnet-confirm")).not.toBeInTheDocument();
    await waitFor(() => expect(send()).toHaveFocus());
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows why a send failed and stays open", async () => {
    const { user, onClose } = open({ withWallet: false, onSend: async () => "Not enough sats at that mint" });
    await user.type(amount(), "21");
    await user.click(send());
    await user.click(screen.getByTestId("review-confirm-send"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Not enough sats at that mint");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows why a request failed", async () => {
    const { user, onClose } = open({ withWallet: false, onRequest: async () => { throw new Error("Mint is down"); } });
    await user.type(amount(), "21");
    await user.click(request());
    expect(await screen.findByRole("alert")).toHaveTextContent("Mint is down");
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("a Testnet and a Mainnet card of one type", () => {
  // Cashu on both networks: a real mint and the test mint. Each card is its own wallet.
  const both = () => everyWallet({ mints: [mint(REAL_MINT, 800), mint(TEST_MINT, 800)], balance: 800 });

  it("offers both, each on its network's tab", async () => {
    const { user } = open({ wallet: both() });
    expect(card("cashu-mainnet")).toBeInTheDocument();
    expect(card("lightning-mainnet")).toBeInTheDocument();
    expect(screen.queryByTestId("payment-card-cashu-testnet")).not.toBeInTheDocument();
    await user.click(tab("testnet"));
    expect(card("cashu-testnet")).toBeInTheDocument();
    expect(card("lightning-testnet")).toBeInTheDocument();
    expect(screen.queryByTestId("payment-card-cashu-mainnet")).not.toBeInTheDocument();
  });

  it.each([
    ["mainnet", "cashu-mainnet", "bitcoin", REAL_MINT],
    ["testnet", "cashu-testnet", "cashu-test", TEST_MINT],
  ] as const)("sends from the %s card on its own network, from its own mint", async (network, id, chain, provider) => {
    const view = open({ wallet: both(), balance: 10_000 });
    view.engine.on("preparePayment", reviewOf);
    await view.user.click(tab(network));
    await view.user.click(card(id));
    expect(screen.getByTestId("payment-back")).toHaveAttribute("data-network", network);
    await view.user.type(amount(), "30");
    await view.user.click(send());
    await screen.findByRole("region", { name: "Payment review" });
    expect(view.engine.callsTo("preparePayment")).toEqual([expect.objectContaining({ network, target: expect.objectContaining({ network: chain, provider }) })]);
  });

  it.each([
    ["mainnet", "lightning-mainnet"],
    ["testnet", "lightning-testnet"],
  ] as const)("requests on the %s card with its network", async (network, id) => {
    const { user, onRequest } = open({ wallet: both() });
    await user.click(tab(network));
    await user.click(card(id));
    await user.type(amount(), "12");
    await user.click(request());
    expect(onRequest).toHaveBeenCalledWith(12, "", "cashu", "lightning", network);
  });
});

describe("sending Cashu from the chat's wallet", () => {
  async function sendCashu(mints: ReturnType<typeof mint>[], sats: string) {
    const view = open({ wallet: everyWallet({ mints, balance: mints.reduce((s, m) => s + m.balance, 0) }), balance: 10_000 });
    view.engine.on("preparePayment", reviewOf);
    // Real money comes first: the Cashu card of these mints' network is picked by hand, on its tab.
    const network = mints[0].url === TEST_MINT ? "testnet" : "mainnet";
    await view.user.click(tab(network));
    await view.user.click(screen.getByTestId(`payment-card-cashu-${network}`));
    await view.user.type(amount(), sats);
    await view.user.type(screen.getByRole("textbox", { name: "What for? (optional)" }), "pizza");
    await view.user.click(send());
    return view;
  }

  it("reviews test ecash from the test mint, as the Cashu test network, on the Testnet wallet", async () => {
    const { engine, onSend } = await sendCashu([mint(TEST_MINT, 500)], "30");
    expect(await screen.findByRole("region", { name: "Payment review" })).toBeInTheDocument();
    expect(engine.callsTo("preparePayment")).toEqual([{
      target: { method: "cashu", network: "cashu-test", provider: TEST_MINT, address: "peer", asset: "BTC", unit: "sat", expiresAt: expect.any(Number) },
      amount: 30, feeCap: 10, payee: "peer", linkId: "link-1", memo: "pizza", network: "testnet",
    }]);
    // With a wallet to review it, nothing goes out before the review is approved.
    expect(onSend).not.toHaveBeenCalled();
  });

  it("names the contact as the review's destination, not their key", async () => {
    await sendCashu([mint(TEST_MINT, 500)], "30");
    const review = await screen.findByRole("region", { name: "Payment review" });
    expect(within(review).getByTestId("review-destination")).toHaveTextContent(/^Alice$/);
  });

  it("pays real sats from a real mint, on the Mainnet wallet", async () => {
    const { engine } = await sendCashu([mint(REAL_MINT, 500)], "30");
    await screen.findByRole("region", { name: "Payment review" });
    expect(engine.callsTo("preparePayment")[0]).toMatchObject({ network: "mainnet", target: { network: "bitcoin", provider: REAL_MINT } });
  });

  it("pays from the mint that holds the most", async () => {
    const { engine } = await sendCashu([mint(OTHER_MINT, 50), mint(REAL_MINT, 500)], "30");
    await screen.findByRole("region", { name: "Payment review" });
    expect(engine.callsTo("preparePayment")[0].target.provider).toBe(REAL_MINT);
  });

  it("still reviews from the fullest mint when none covers the amount and its fee", async () => {
    // 30 sats and up to 10 in fees: neither mint holds 40. The review is where the shortfall shows.
    const { engine } = await sendCashu([mint(OTHER_MINT, 20), mint(REAL_MINT, 35)], "30");
    await screen.findByRole("region", { name: "Payment review" });
    expect(engine.callsTo("preparePayment")[0].target.provider).toBe(REAL_MINT);
  });

  it("shows why the payment could not be prepared", async () => {
    const view = open();
    view.engine.on("preparePayment", () => { throw new Error("Mint is offline"); });
    await view.user.click(screen.getByTestId("payment-use"));
    await view.user.type(amount(), "10");
    await view.user.click(send());
    expect(await screen.findByRole("alert")).toHaveTextContent("Mint is offline");
    expect(send()).toHaveTextContent("Send");
  });
});

// The memo reaches the contact as a message's text does, and the CLI's `chat pay`/`chat request` guard it: the sheet
// sent a seed typed there with no question, where the composer asks.
describe("a memo that looks like a seed or a key", () => {
  const SEED = `${"abandon ".repeat(11)}about`;
  const memo = () => screen.getByRole("textbox", { name: "What for? (optional)" });

  it("asks before a request carries it; Cancel keeps it here, Send anyway sends it", async () => {
    const { user, onRequest } = open();
    await user.click(tab("mainnet"));
    await user.click(card("lightning-mainnet"));
    await user.type(amount(), "12");
    await user.type(memo(), SEED);
    await user.click(request());
    expect(await screen.findByTestId("secret-guard")).toHaveAttribute("data-kind", "mnemonic");
    await user.click(screen.getByTestId("secret-guard-cancel"));
    expect(screen.queryByTestId("secret-guard")).not.toBeInTheDocument();
    expect(onRequest).not.toHaveBeenCalled();
    await user.click(request());
    await user.click(await screen.findByTestId("secret-guard-send"));
    expect(onRequest).toHaveBeenCalledWith(12, SEED, "cashu", "lightning", "mainnet");
  });

  it("asks before a send carries it, and prepares nothing until it is answered", async () => {
    const view = open({ wallet: everyWallet({ mints: [mint(TEST_MINT, 500)], balance: 500 }) });
    view.engine.on("preparePayment", reviewOf);
    await view.user.click(tab("testnet"));
    await view.user.click(card("cashu-testnet"));
    await view.user.type(amount(), "30");
    await view.user.type(memo(), "my nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5 for you");
    await view.user.click(send());
    expect(await screen.findByTestId("secret-guard")).toHaveAttribute("data-kind", "nsec");
    expect(view.engine.callsTo("preparePayment")).toEqual([]);
    await view.user.click(screen.getByTestId("secret-guard-send"));
    await screen.findByRole("region", { name: "Payment review" });
    expect(view.engine.callsTo("preparePayment")).toEqual([expect.objectContaining({ memo: expect.stringContaining("nsec1") })]);
  });

  // The sheet's Escape (back to the cards) listens first, on the document: it took the guard's Escape, turned the card
  // back to the deck behind the dialog, and the browser's own Escape on the dialog never came, so the guard stayed.
  it("leaves Escape to the guard: the card stays turned, the sheet open", async () => {
    const view = open({ wallet: everyWallet({ mints: [mint(TEST_MINT, 500)], balance: 500 }) });
    await view.user.click(tab("testnet"));
    await view.user.click(card("cashu-testnet"));
    await view.user.type(amount(), "30");
    await view.user.type(memo(), SEED);
    await view.user.click(send());
    await screen.findByTestId("secret-guard");
    await view.user.keyboard("{Escape}");
    // Longer than a turn back takes.
    await new Promise((resolve) => setTimeout(resolve, FLIP_MS + 100));
    expect(screen.queryByRole("radiogroup", { name: "Pay with" })).not.toBeInTheDocument();
    expect(amount()).toHaveValue("30");
    expect(view.onClose).not.toHaveBeenCalled();
  });

  // Send anyway gives the focus back to the button that asked, which the work it starts makes busy at that moment: a
  // natively disabled button takes no focus, so it fell to the page while the work ran and stayed there on a refusal.
  it("keeps a keyboard's focus on Request after Send anyway, while it works and when it is refused", async () => {
    let refuse!: (why: string) => void;
    const { user } = open({ onRequest: () => new Promise<string | null>((resolve) => { refuse = resolve; }) });
    await user.click(tab("mainnet"));
    await user.click(card("lightning-mainnet"));
    await user.type(amount(), "12");
    await user.type(memo(), SEED);
    request().focus();
    await user.keyboard("{Enter}");
    const guard = await screen.findByTestId("secret-guard");
    within(guard).getByTestId("secret-guard-send").focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByTestId("secret-guard")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(request());
    expect(request()).toHaveTextContent("Requesting");
    expect(request()).toHaveAttribute("aria-disabled", "true");
    await act(async () => refuse("The contact's app is offline"));
    expect(await screen.findByRole("alert")).toHaveTextContent("The contact's app is offline");
    expect(document.activeElement).toBe(request());
  });

  it("keeps a keyboard's focus on Send after Send anyway when the send is refused", async () => {
    const view = open({ wallet: everyWallet({ mints: [mint(TEST_MINT, 500)], balance: 500 }) });
    view.engine.on("preparePayment", () => { throw new Error("Mint is offline"); });
    await view.user.click(tab("testnet"));
    await view.user.click(card("cashu-testnet"));
    await view.user.type(amount(), "30");
    await view.user.type(memo(), SEED);
    send().focus();
    await view.user.keyboard("{Enter}");
    within(await screen.findByTestId("secret-guard")).getByTestId("secret-guard-send").focus();
    await view.user.keyboard("{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Mint is offline");
    expect(document.activeElement).toBe(send());
  });

  it("asks nothing of an ordinary memo", async () => {
    const { user, onRequest } = open();
    await user.click(tab("mainnet"));
    await user.click(card("lightning-mainnet"));
    await user.type(amount(), "12");
    await user.type(memo(), "pizza");
    await user.click(request());
    expect(screen.queryByTestId("secret-guard")).not.toBeInTheDocument();
    expect(onRequest).toHaveBeenCalledWith(12, "pizza", "cashu", "lightning", "mainnet");
  });
});

// Send or Request at work (or held from the keys) is `aria-disabled`, not disabled: its hover answered as a live one's
// did, Send brighter and Request lighter under the pointer while they read "Preparing…" or "Requesting…". Hover itself
// is measured in a browser; here, the rules that give it.
describe("PaymentComposer: the CSS of Send and Request", () => {
  const CSS = readFileSync(join(fileURLToPath(import.meta.url), "../../../components/payment-composer.css"), "utf8");

  it("a busy or held Send or Request does not answer the pointer's hover", () => {
    const hovers = CSS.split(/\r?\n/).filter((line) => /^\.payment-back-(primary|secondary)[^{]*:hover/.test(line.trim()));
    expect(hovers).toHaveLength(2);
    for (const line of hovers) expect(line).toMatch(/:not\(\[aria-disabled="?true"?\]\)/);
  });
});

describe("sending on Ark, Bark, on-chain and USDT", () => {
  // The composer looks for the contact's answer every 400 ms and gives up after 45 s: only those clocks are faked.
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] }); });
  afterEach(() => { vi.useRealTimers(); });
  const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

  async function ask(id: string, typed: string) {
    rememberRail("peer", id);
    const view = open();
    view.engine.on("askToPay", () => ({ askId: "ask-1" })).on("preparePayment", reviewOf);
    await view.user.click(screen.getByTestId("payment-use"));
    await view.user.type(amount(), typed);
    await view.user.type(screen.getByRole("textbox", { name: "What for? (optional)" }), "lunch");
    await view.user.click(send());
    expect(await screen.findByText("Asking for an address…")).toBeInTheDocument();
    return view;
  }

  it.each([
    ["arkade", "arkade:testnet", "250", 250],
    ["bark", "bark:testnet", "250", 250],
    ["bitcoin", "bitcoin:mainnet", "250", 250],
    ["usdt", "usdt:testnet", "2.5", 2_500_000],
  ])("on %s, asks the contact's app for an address first, on the card's network", async (rail, id, typed, units) => {
    const { engine } = await ask(id, typed);
    expect(engine.callsTo("askToPay")).toEqual([{ linkId: "link-1", amount: units, method: rail, memo: "lunch", timestamp: expect.any(Number), network: id.split(":")[1] }]);
    // Send was pressed and keeps the focus while it waits: off by aria-disabled. Request is plain disabled.
    expect(send()).toHaveAttribute("aria-disabled", "true");
    expect(request()).toBeDisabled();
    expect(engine.callsTo("preparePayment")).toEqual([]);
  });

  it.each([
    ["arkade:testnet", target({ method: "arkade" }), 10],
    ["bitcoin:mainnet", target({ method: "bitcoin", provider: "onchain", address: "bcrt1qpayee" }), 2_000],
    ["usdt:testnet", target({ method: "usdt", network: "sepolia", asset: "TEST-USDT", unit: "token-base", decimals: 6 }), 10 ** 15],
  ])("on %s, reviews the request the contact's app answers with, on the card's network", async (id, answer, feeCap) => {
    const { engine } = await ask(id, "3");
    act(() => engine.update({ payments: { "req-1": paymentView({ id: "req-1", kind: "request", direction: "in", ask: "ask-1", amount: 3, target: answer }) } }));
    tick(400);
    expect(await screen.findByRole("region", { name: "Payment review" })).toBeInTheDocument();
    expect(engine.callsTo("preparePayment")).toEqual([{ target: answer, amount: 3, feeCap, payee: "peer", linkId: "link-1", requestId: "req-1", network: id.split(":")[1] }]);
  });

  it("does not take a request that answers another ask", async () => {
    const { engine } = await ask("arkade:testnet", "3");
    act(() => engine.update({ payments: { "req-2": paymentView({ id: "req-2", kind: "request", direction: "in", ask: "ask-other", target: target() }) } }));
    tick(2_000);
    expect(engine.callsTo("preparePayment")).toEqual([]);
    expect(send()).toHaveTextContent("Asking for an address…");
  });

  it("gives up when the contact's app does not answer", async () => {
    await ask("arkade:testnet", "3");
    tick(45_600);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your contact's app didn't answer" + "They can send you a Request instead.");
    expect(send()).toHaveTextContent("Send");
    expect(send()).toBeEnabled();
  });

  it("gives up 45 s after Send asked, though the chat behind redraws the sheet with a new context every few seconds", async () => {
    // The chat page builds its review context on every draw (a message, a link or wallet change): the 45 s started
    // again at each, and in a live chat the sheet said "Asking for an address…" for good, Send disabled.
    const { rerender, onSend, onRequest, onClose } = await ask("arkade:testnet", "3");
    for (let s = 10; s <= 40; s += 10) {
      tick(10_000);
      rerender(<><PaymentComposer balance={1_000} onSend={onSend} onRequest={onRequest} onClose={onClose} reviewContext={reviewContext()} contact="Alice" /><Where /></>);
      expect(send()).toHaveTextContent("Asking for an address…");
    }
    tick(5_600);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your contact's app didn't answer");
    expect(send()).toBeEnabled();
  });

  it("shows why the contact could not be asked", async () => {
    rememberRail("peer", "bark:testnet");
    const { user, engine } = open();
    engine.on("askToPay", () => { throw new Error("Your contact is offline"); });
    await user.click(screen.getByTestId("payment-use"));
    await user.type(amount(), "3");
    await user.click(send());
    expect(await screen.findByRole("alert")).toHaveTextContent("Your contact is offline");
    expect(send()).toHaveTextContent("Send");
  });
});

describe("PaymentComposer: the keys on a phone", () => {
  const viewport = (width: number, height = 800) => (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height });
  afterEach(() => { viewport(1024, 768); });

  it("keeps Tab and Shift+Tab in the sheet, never on the page behind its backdrop", async () => {
    // The sheet covers the chat with its backdrop, as a dialog does: Tab from its last control went on to the chat
    // under it, Shift+Tab from its first to the composer's buttons, the sheet still open.
    viewport(390, 844);
    fakeEngine.setState({ links: [linkView()], wallet: everyWallet() });
    const { user } = renderApp(<><button>Before</button>
      <PaymentComposer balance={1_000} onSend={async () => null} onRequest={async () => null} onClose={() => {}} reviewContext={reviewContext()} contact="Alice" />
      <button>After</button></>);
    const sheet = screen.getByTestId("payment-composer");
    act(() => screen.getByTestId("payment-use").focus());
    for (const shift of [false, true]) {
      for (let i = 0; i < 12; i++) {
        await user.tab({ shift });
        expect(sheet).toContainElement(document.activeElement as HTMLElement);
      }
    }
  });
});

// covers: payments.usdt.send, payments.bitcoin.offer, payments.chat.networks
describe("the payment sheet's balance checks and its cards not ready yet", () => {
  /**
   * Two things the composer used to get wrong, found by these tests: USDT's over-balance check, and how an unready
   * card explains itself.
   */

  function open(wallet: Partial<WalletView>, sendUnavailable?: string) {
    fakeEngine.setState({ links: [linkView()], wallet });
    return renderApp(<PaymentComposer balance={1_000} onSend={async () => null} onRequest={async () => null} onClose={() => {}} reviewContext={reviewContext()} contact="Alice" sendUnavailable={sendUnavailable} />);
  }

  /** A wallet the profile has, as the engine lists it, for one the flat fields would not make (nothing set up yet). */
  const instance = (type: WalletInstanceView["type"], network: WalletNetwork): WalletInstanceView => ({ id: `${type}:${network}`, type, network, config: {} });

  // USDT's balance is in the token's smallest units (2 TEST-USDT is "2000000") and the amount in whole tokens. It
  // was compared as is: 3 on a card holding 2 passed, and the hint only came past 2,000,000 tokens.
  it("warns when a USDT amount is more than the card holds", async () => {
    rememberRail("peer", "usdt:testnet");
    const { user } = open(everyWallet({ usdt: usdtReady({ balance: "2000000", decimals: 6 }) }));
    await user.click(screen.getByTestId("payment-use"));
    await user.type(screen.getByTestId("payment-amount"), "3");
    expect(screen.getByText("More than the 2 TEST-USDT on this card.")).toBeInTheDocument();
    expect(screen.getByTestId("payment-send")).toBeDisabled();
  });

  // A Lightning card on its own node (LND, CLN, NWC, Breez...) was checked against the Cashu balance: with no ecash, any
  // amount said "More than the 0 sats on this card". It reads its own source's balance, and claims none it has not read.
  describe("a Lightning card with its own source", () => {
    const lightningOn = (lightning: Partial<NonNullable<WalletView["lightning"]>>) => {
      rememberRail("peer", "lightning:mainnet");
      return open(everyWallet({ mints: [mint(REAL_MINT, 0)], balance: 0, lightning: lightningSource({ providerId: "lnd-1", alias: "My node", ...lightning }) }));
    };

    it("checks an amount against its source's balance, not the Cashu one", async () => {
      const { user } = lightningOn({ balance: 5_000 });
      await user.click(screen.getByTestId("payment-use"));
      expect(screen.getByTestId("payment-back")).toHaveClass("wallet-card-lightning");
      await user.type(screen.getByTestId("payment-amount"), "100");
      expect(screen.queryByText(/^More than/)).not.toBeInTheDocument();
      expect(screen.getByTestId("payment-request")).toBeEnabled();
      // Lightning in a chat can only Request, and a request spends nothing: no amount is more than the card holds.
      await user.clear(screen.getByTestId("payment-amount"));
      await user.type(screen.getByTestId("payment-amount"), "6000");
      expect(screen.queryByText(/^More than/)).not.toBeInTheDocument();
      expect(document.querySelector(".payment-back-hint")).not.toHaveTextContent(/More than/);
      expect(screen.getByTestId("payment-request")).toBeEnabled();
    });

    // Ready, but its source has not said what it holds: no number to compare with. (One reconnecting or failing is not
    // ready, so the sheet does not open on it: walletCardData.test.ts has those.)
    it("claims no number while its source has not read a balance", async () => {
      const { user } = lightningOn({});
      await user.click(screen.getByTestId("payment-use"));
      expect(screen.getByTestId("payment-back")).toHaveClass("wallet-card-lightning");
      await user.type(screen.getByTestId("payment-amount"), "100");
      expect(screen.queryByText(/^More than/)).not.toBeInTheDocument();
      expect(screen.getByTestId("payment-request")).toBeEnabled();
    });
  });

  // "More than the X on this card" is about Send, which spends from the card. A Request spends nothing, so it said
  // "More than the 1,000 sats" on a Lightning card (which can only Request in a chat) asked for 2,000. Every rail that
  // can Send warns and keeps Send off; Request stays on, and where Request is all there is, nothing warns.
  describe("the over-balance hint", () => {
    const fed = { federations: [{ id: "ab".repeat(32), name: "Fed", guardians: [], consensusVersion: "2.1", network: "regtest" as const, modules: [], joinedAt: 1, invite: "fed11qq", balance: 2_000, status: "ready" as const, lightning: true }], balance: 2_000, history: [] };
    const over = async (id: string, typed: string, wallet: Partial<WalletView> = {}, sendUnavailable?: string) => {
      rememberRail("peer", id);
      const { user } = open(everyWallet({ fedimint: fed, ...wallet }), sendUnavailable);
      await user.click(screen.getByTestId("payment-use"));
      expect(screen.getByTestId("payment-back")).toHaveClass(`wallet-card-${id.split(":")[0]}`);
      await user.type(screen.getByTestId("payment-amount"), typed);
    };

    it.each([
      ["cashu:mainnet", "1500", "More than the 1,000 sats on this card."],
      ["arkade:testnet", "6000", "More than the 5,000 test sats on this card."],
      ["bark:testnet", "4000", "More than the 3,000 test sats on this card."],
      ["spark:testnet", "5000", "More than the 4,000 test sats on this card."],
      ["bitcoin:mainnet", "20000", "More than the 10,000 sats on this card."],
      ["fedimint:testnet", "3000", "More than the 2,000 test sats on this card."],
      ["usdt:testnet", "6", "More than the 5 TEST-USDT on this card."],
    ])("%s, which can Send, warns past its balance and keeps only Request on", async (id, typed, hint) => {
      await over(id, typed);
      expect(screen.getByText(hint)).toBeInTheDocument();
      expect(screen.getByTestId("payment-amount").closest("label")).toHaveAttribute("data-over", "true");
      expect(screen.getByTestId("payment-send")).toBeDisabled();
      expect(screen.getByTestId("payment-request")).toBeEnabled();
    });

    it("says nothing of the balance on Lightning through the Cashu mints, which can only Request", async () => {
      await over("lightning:mainnet", "2000");
      expect(screen.queryByText(/^More than/)).not.toBeInTheDocument();
      expect(screen.getByTestId("payment-amount").closest("label")).not.toHaveAttribute("data-over");
      expect(screen.getByTestId("payment-request")).toBeEnabled();
    });

    it("says nothing of the balance on a request to a group, which has no Send", async () => {
      await over("cashu:mainnet", "1500", {}, "A request to the group is paid by one member");
      expect(screen.queryByText(/^More than/)).not.toBeInTheDocument();
      expect(screen.getByTestId("payment-send")).toBeDisabled();
      expect(screen.getByTestId("payment-request")).toBeEnabled();
    });
  });

  // With the contact away, Send stays off: ecash goes only over a live connection. Why was said only in Send's tooltip,
  // which a phone never shows, while the line under the amount still said "Send gives your contact ecash straight away".
  describe("Send off while the contact is away", () => {
    const away = "Send needs your contact online: ecash never waits in a queue. A request can wait until they are back.";

    it("says why under the amount, on a card that could Send, and leaves Request on", async () => {
      rememberRail("peer", "cashu:mainnet");
      const { user } = open(everyWallet({}), away);
      await user.click(screen.getByTestId("payment-use"));
      await user.type(screen.getByTestId("payment-amount"), "21");
      expect(document.querySelector(".payment-back-hint")).toHaveTextContent(away);
      expect(document.querySelector(".payment-back-hint")).not.toHaveTextContent(/straight away/);
      expect(screen.getByTestId("payment-send")).toBeDisabled();
      expect(screen.getByTestId("payment-request")).toBeEnabled();
    });

    it("leaves Lightning's own words, which can only Request in a chat anyway", async () => {
      rememberRail("peer", "lightning:mainnet");
      const { user } = open(everyWallet({}), away);
      await user.click(screen.getByTestId("payment-use"));
      expect(document.querySelector(".payment-back-hint")).toHaveTextContent(/tap Pay on their request/);
    });
  });

  // A card that is not ready explains itself with its balance line ("Ark is connecting…"), but one with nothing set
  // up said "Cashu is 0 sats" (as if money were the problem) or "Bitcoin is no source". It says it is not set up.
  it("says a Cashu card without a mint has to be set up, not that it holds 0 sats", () => {
    open(everyWallet({ mints: [], balance: 0, wallets: [instance("cashu", "mainnet"), instance("arkade", "testnet")] }));
    const cashu = screen.getByTestId("payment-card-cashu-mainnet");
    expect(cashu).toHaveAttribute("aria-disabled", "true");
    expect(cashu.getAttribute("title")).not.toBe("Cashu is 0 sats");
    expect(cashu.getAttribute("title")).toMatch(/set up/i);
  });

  it("says Lightning through the Cashu mints has to be set up when there is no mint", () => {
    open(everyWallet({ mints: [], balance: 0, lightning: undefined, wallets: [instance("lightning", "mainnet"), instance("arkade", "testnet")] }));
    expect(screen.getByTestId("payment-card-lightning-mainnet").getAttribute("title")).toBe("Lightning is not set up yet");
  });

  it("still says where a card on its way is", () => {
    // An Ark wallet whose provider has not answered yet: it has no address to be paid at.
    open(everyWallet({ ark: undefined, wallets: [instance("arkade", "testnet")] }));
    expect(screen.getByTestId("payment-card-arkade-testnet").getAttribute("title")).toBe("Ark is connecting…");
  });

  it("says a Bitcoin card without a source has to be set up", () => {
    open(everyWallet({ bitcoin: undefined, wallets: [instance("cashu", "mainnet"), instance("bitcoin", "mainnet")] }));
    expect(screen.getByTestId("payment-card-bitcoin-mainnet").getAttribute("title")).toMatch(/set up/i);
  });

  it("shows no card for a wallet the profile does not have", () => {
    // No source, no Ark: the engine lists no such wallet, so the chat has no card for it.
    open(everyWallet({ bitcoin: undefined, ark: undefined }));
    expect(screen.queryByTestId("payment-card-bitcoin-mainnet")).not.toBeInTheDocument();
    expect(screen.queryByTestId("payment-card-arkade-testnet")).not.toBeInTheDocument();
    expect(screen.getByTestId("payment-card-cashu-mainnet")).toBeInTheDocument();
  });
});

// covers: payments.chat.cards, payments.cashu.request
describe("Request and Send while the chosen card turns", () => {
  /**
   * A Request or Send click that landed while the chosen card was still turning reached nothing (the matrix, #762): the
   * person had to click again. Until the turn is over the two buttons wait, faded out; then they take the first click.
   * These tests give the card its turn (the UI tests load no stylesheets), a short one: the guard reads its length. In
   * longhands: happy-dom does not expand the `transition` shorthand.
   */
  const TURN_MS = 150;
  let turn: HTMLStyleElement;
  beforeEach(() => {
    turn = document.createElement("style");
    turn.textContent = `.deck-flip-card{transition-property:transform;transition-duration:${TURN_MS}ms}`;
    document.head.append(turn);
  });
  afterEach(() => turn.remove());

  function open() {
    fakeEngine.setState({ links: [linkView()], wallet: everyWallet() });
    rememberRail("peer", "cashu:mainnet");
    const onRequest = vi.fn(async () => null);
    const view = renderApp(<PaymentComposer balance={1_000} onSend={async () => null} onRequest={onRequest} onClose={() => {}} reviewContext={reviewContext()} contact="Alice" />);
    return { ...view, onRequest };
  }

  it("keeps Request and Send waiting while the card turns, then takes the first click", async () => {
    const { user, onRequest } = open();
    await user.click(screen.getByTestId("payment-use"));
    await user.type(screen.getByTestId("payment-amount"), "21");
    const request = screen.getByTestId("payment-request");
    // Mid-turn: out of sight and not clickable, a click is not lost to a card still swinging round.
    expect(request).toBeDisabled();
    expect(screen.getByTestId("payment-send")).toBeDisabled();
    expect(request.parentElement).toHaveAttribute("data-turning", "true");
    await waitFor(() => expect(request).toBeEnabled());
    expect(screen.getByTestId("payment-send")).toBeEnabled();
    expect(request.parentElement).not.toHaveAttribute("data-turning");
    await user.click(request);
    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(onRequest).toHaveBeenCalledWith(21, "", "cashu", "cashu", "mainnet");
  });

  it("waits again when the card is turned back and over once more", async () => {
    const { user } = open();
    await user.click(screen.getByTestId("payment-use"));
    await user.type(screen.getByTestId("payment-amount"), "5");
    await waitFor(() => expect(screen.getByTestId("payment-request")).toBeEnabled());
    await user.click(screen.getByTestId("payment-change-card"));
    await user.click(await screen.findByTestId("payment-use"));
    await user.type(screen.getByTestId("payment-amount"), "5");
    expect(screen.getByTestId("payment-request")).toBeDisabled();
    await waitFor(() => expect(screen.getByTestId("payment-request")).toBeEnabled());
  });

  // With motion reduced there is no turn (flip.css takes the card's transition away, the faces cross-fade where they
  // are): nothing to wait for.
  it("does not wait with motion reduced", async () => {
    document.documentElement.dataset.reduceMotion = "true";
    turn.textContent = `.deck-flip-card{transition-property:none;transition-duration:0s}`;
    const { user } = open();
    await user.click(screen.getByTestId("payment-use"));
    await user.type(screen.getByTestId("payment-amount"), "5");
    // Flipped two frames after the click (useCardFlip.ts), so the fade starts from a painted face: enabled from then on.
    await waitFor(() => expect(screen.getByTestId("payment-request").closest(".deck-flip")).toHaveAttribute("data-flipped", "true"));
    expect(screen.getByTestId("payment-request")).toBeEnabled();
    expect(screen.getByTestId("payment-request").parentElement).not.toHaveAttribute("data-turning");
  });
});

// covers: payments.chat.cards, payments.chat.networks, payments.chat.methods
describe("the payment sheet's network tabs", () => {
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

    it("gives a finger 44 px on a phone: Pay or request | Accept, the deck's arrows and Back to the cards", async () => {
      const { user } = open();
      for (const m of ["pay", "accept"]) expect(screen.getByTestId(`payment-mode-${m}`)).toHaveClass("max-md:min-h-11");
      const arrows = [...screen.getAllByRole("button", { name: "Previous card" }), ...screen.getAllByRole("button", { name: "Next card" })];
      expect(arrows).toHaveLength(2);
      for (const arrow of arrows) expect(arrow).toHaveClass("max-md:min-h-[44px]", "max-md:min-w-[44px]");
      await user.click(screen.getByTestId("payment-card-lightning-mainnet"));
      expect(screen.getByRole("button", { name: "Cards" })).toHaveClass("max-md:min-h-[44px]");
    });

    it("pays a card of the tab on its own network, and goes back to that tab from the card", async () => {
      const { user, onRequest } = open();
      await user.click(tab("testnet"));
      await user.click(screen.getByTestId("payment-card-lightning-testnet"));
      await user.click(screen.getByRole("button", { name: "Cards" }));
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
});

// covers: payments.chat.cards, payments.chat.methods, app.i18n
describe("the payment sheet's names, each in its own direction", () => {
  /*
   * The chat's payment sheet says whom it pays and with which card in its sentences: the contact's name and the card's
   * are someone's own words, in any script. Each is its own <bdi>, as a call's or a device's name is, or what sits at its
   * edge took the sentence's direction: in Arabic "Bob 🚀" read "🚀 Bob", "Bob!" read "!Bob"; in English an Arabic
   * name's emoji went to its other side.
   */

  const BOB = "Bob 🚀";

  beforeEach(() => { document.documentElement.dataset.reduceMotion = "true"; });

  function open(wallet: Partial<WalletView> = everyWallet(), language: "ar" | "en" = "ar", contact = BOB) {
    fakeEngine.setState({ links: [linkView()], wallet });
    const view = renderApp(<PaymentComposer balance={1_000} onSend={vi.fn(async () => null)} onRequest={vi.fn(async () => null)} onClose={vi.fn()}
      onSaveMethods={vi.fn(async () => {})} reviewContext={reviewContext()} contact={contact} />, { language });
    document.documentElement.dataset.reduceMotion = "true";
    return view;
  }

  /** The <bdi>s inside the element, by their text. */
  const isolated = (el: Element) => [...el.querySelectorAll("bdi")].map((bdi) => bdi.textContent);
  const one = (selector: string) => document.querySelector(selector)!;

  it("whom the sheet is with, what Send does with them, and the card Use goes on with", () => {
    open();
    expect(isolated(one(".composer-sheet-who"))).toEqual([BOB]);
    expect(isolated(one(".composer-sheet-hint"))).toContain(BOB);
    const use = screen.getByTestId("payment-use");
    expect(isolated(use)).toHaveLength(1);
    expect(use.textContent).toContain(isolated(use)[0]);
  });

  it("the card's back: the balance with them, and what Send does", async () => {
    const { user } = open();
    await user.click(screen.getByTestId("payment-use"));
    expect(isolated(one(".payment-back-meta"))).toEqual([BOB]);
    expect(isolated(one(".payment-back-hint"))).toContain(BOB);
  });

  it("Accept's hint and status", async () => {
    const { user } = open();
    await user.click(screen.getByTestId("payment-mode-accept"));
    expect(isolated(screen.getByTestId("payment-accept-hint"))).toContain(BOB);
    await user.click(screen.getAllByRole("switch")[0]);
    expect(isolated(screen.getByTestId("payment-accept-status"))).toEqual([BOB]);
  });

  it("no wallet yet", () => {
    open({});
    expect(isolated(screen.getByTestId("payment-no-wallet"))).toEqual([BOB]);
  });

  it("an Arabic name in the English app, and the text stays the same", () => {
    open(everyWallet(), "en", "محمد 🚀");
    expect(isolated(one(".composer-sheet-who"))).toEqual(["محمد 🚀"]);
    expect(one(".composer-sheet-who")).toHaveTextContent("with محمد 🚀");
  });
});

// covers: payments.chat.cards, payments.chat.review, payments.cashu.send, payments.cashu.request, payments.mainnet-confirm
describe("the chat's payment sheet once a payment or request is done", () => {
  /**
   * A payment sent or a request made from the chat's sheet ends there: the sheet closes, the chat is back with the
   * keyboard on the message field, and the chat's bubble shows how it goes, even when it came back before Approve answered. A failure keeps the sheet, with its error
   * and the way to try again. Real money still asks once more before anything goes, and closes only once it went.
   */

  beforeEach(() => { document.documentElement.dataset.reduceMotion = "true"; });

  function composer({ wallet = everyWallet({ mints: [mint(REAL_MINT, 1_000), mint(TEST_MINT, 1_000)], balance: 1_000 }), onRequest = async () => null }: { wallet?: Partial<WalletView>; onRequest?: () => Promise<string | null> } = {}) {
    fakeEngine.setState({ links: [linkView()], wallet });
    const request = vi.fn(onRequest);
    const view = renderApp(<LockScreenProvider><MessageInput onSend={async () => null}
      payments={{ balance: 1_000, contact: "Alice", onSend: async () => null, onRequest: request, reviewContext: reviewContext(), onSaveMethods: async () => {} }} /></LockScreenProvider>);
    view.engine.on("preparePayment", reviewOf);
    return { ...view, request };
  }

  const sheet = () => screen.queryByTestId("payment-composer");
  const field = () => screen.getByPlaceholderText("Message…");

  /** + → Payment, a card turned over, an amount. */
  async function start(user: ReturnType<typeof composer>["user"], card: string) {
    await user.click(screen.getByTestId("composer-more"));
    await user.click(screen.getByTestId("payment-button"));
    await user.click(screen.getByTestId(`payment-card-${card}`));
    await user.type(screen.getByTestId("payment-amount"), "21");
  }

  describe("sent", () => {
    it("test money: Approve sends, the sheet closes and the message field has the keyboard", async () => {
      rememberRail("peer", "cashu:testnet");
      const { user, engine } = composer();
      engine.on("approvePayment", (params) => ({ ...reviewOf({ target: { method: "cashu", network: "cashu-test", provider: TEST_MINT, address: "peer", asset: "BTC", unit: "sat", expiresAt: Date.now() + 60_000 }, amount: 21, feeCap: 10, payee: "peer", linkId: "link-1" }), id: params.id, state: "settled" }));
      await start(user, "cashu-testnet");
      await user.click(screen.getByTestId("payment-send"));
      await user.click(await screen.findByTestId("review-approve"));
      expect(engine.callsTo("approvePayment")).toEqual([{ id: "review-1" }]);
      expect(sheet()).not.toBeInTheDocument();
      expect(field()).toHaveFocus();
    });

    it("real money: the confirmation comes first; the sheet closes only once the payment went", async () => {
      rememberRail("peer", "cashu:mainnet");
      const { user, engine } = composer();
      engine.on("approvePayment", (params) => ({ ...reviewOf({ target: { method: "cashu", network: "bitcoin", provider: REAL_MINT, address: "peer", asset: "BTC", unit: "sat", expiresAt: Date.now() + 60_000 }, amount: 21, feeCap: 10, payee: "peer", linkId: "link-1" }), id: params.id, state: "submitted" }));
      await start(user, "cashu-mainnet");
      await user.click(screen.getByTestId("payment-send"));
      await user.click(await screen.findByTestId("review-approve"));
      expect(screen.getByTestId("review-mainnet-confirm")).toBeInTheDocument();
      expect(sheet()).toBeInTheDocument();
      expect(engine.callsTo("approvePayment")).toEqual([]);
      await user.click(screen.getByTestId("review-confirm-send"));
      expect(engine.callsTo("approvePayment")).toEqual([{ id: "review-1", confirmedReal: true }]);
      expect(sheet()).not.toBeInTheDocument();
    });

    // The contact refused it and the ecash came back before Approve answered: it went out all the same, and its bubble
    // says how it ended. The sheet closed only when Approve won that race.
    it.each([
      ["taken back", { error: engineText("paymentTakenBack") }],
      ["refused, its sats back", { error: "Refused: Ecash from 127.0.0.1 is not accepted. All 21 sats came back.", returned: { amount: 21, fee: 0 } }],
    ])("a payment %s before Approve answers: the sheet closes all the same", async (_, ended) => {
      rememberRail("peer", "cashu:testnet");
      const { user, engine } = composer();
      engine.on("approvePayment", (params) => ({ ...reviewOf({ target: { method: "cashu", network: "cashu-test", provider: TEST_MINT, address: "peer", asset: "BTC", unit: "sat", expiresAt: Date.now() + 60_000 }, amount: 21, feeCap: 10, payee: "peer", linkId: "link-1" }), id: params.id, state: "failed", ...ended }));
      await start(user, "cashu-testnet");
      await user.click(screen.getByTestId("payment-send"));
      await user.click(await screen.findByTestId("review-approve"));
      expect(sheet()).not.toBeInTheDocument();
      expect(field()).toHaveFocus();
    });
  });

  describe("requested", () => {
    it("closes the sheet once the request is made, back to the message field", async () => {
      rememberRail("peer", "lightning:testnet");
      const { user, request } = composer();
      await start(user, "lightning-testnet");
      await user.click(screen.getByTestId("payment-request"));
      expect(request).toHaveBeenCalledWith(21, "", "cashu", "lightning", "testnet");
      expect(sheet()).not.toBeInTheDocument();
      expect(field()).toHaveFocus();
    });
  });

  describe("closed", () => {
    /** A payment the mint left unconfirmed: its review, with Check and Close. */
    async function unconfirmed() {
      rememberRail("peer", "cashu:testnet");
      const { user, engine } = composer();
      engine.on("approvePayment", (params) => ({ ...reviewOf({ target: { method: "cashu", network: "cashu-test", provider: TEST_MINT, address: "peer", asset: "BTC", unit: "sat", expiresAt: Date.now() + 60_000 }, amount: 21, feeCap: 10, payee: "peer", linkId: "link-1" }), id: params.id, state: "unknown" }));
      await start(user, "cashu-testnet");
      await user.click(screen.getByTestId("payment-send"));
      await user.click(await screen.findByTestId("review-approve"));
      await within(screen.getByTestId("payment-review")).findByRole("button", { name: "Close" });
      return user;
    }

    it("the review's Close gives the keyboard back to the message field, not to the page", async () => {
      const user = await unconfirmed();
      await user.click(within(screen.getByTestId("payment-review")).getByRole("button", { name: "Close" }));
      expect(sheet()).not.toBeInTheDocument();
      expect(field()).toHaveFocus();
    });

    it("Escape in the review does the same", async () => {
      const user = await unconfirmed();
      expect(sheet()).toContainElement(document.activeElement as HTMLElement);
      await user.keyboard("{Escape}");
      expect(sheet()).not.toBeInTheDocument();
      expect(field()).toHaveFocus();
    });
  });

  describe("a failure stays", () => {
    it("an approval that throws: the error shows, and Approve is there to try again", async () => {
      rememberRail("peer", "cashu:testnet");
      const { user, engine } = composer();
      engine.on("approvePayment", () => { throw new Error("Mint unreachable"); });
      await start(user, "cashu-testnet");
      await user.click(screen.getByTestId("payment-send"));
      await user.click(await screen.findByTestId("review-approve"));
      expect(await screen.findByRole("alert")).toHaveTextContent("Mint unreachable");
      expect(sheet()).toBeInTheDocument();
      expect(screen.getByTestId("review-approve")).toBeEnabled();
    });

    it("a payment that failed: its status and error stay in the sheet", async () => {
      rememberRail("peer", "cashu:testnet");
      const { user, engine } = composer();
      engine.on("approvePayment", (params) => ({ ...reviewOf({ target: { method: "cashu", network: "cashu-test", provider: TEST_MINT, address: "peer", asset: "BTC", unit: "sat", expiresAt: Date.now() + 60_000 }, amount: 21, feeCap: 10, payee: "peer", linkId: "link-1" }), id: params.id, state: "failed", error: "Token rejected" }));
      await start(user, "cashu-testnet");
      await user.click(screen.getByTestId("payment-send"));
      await user.click(await screen.findByTestId("review-approve"));
      const review = screen.getByTestId("payment-review");
      expect(await within(review).findByTestId("review-status")).toHaveTextContent("failed");
      expect(review).toHaveTextContent("Token rejected");
      expect(sheet()).toBeInTheDocument();
    });

    it("a request that fails: the error shows on the card, and Request can be pressed again", async () => {
      rememberRail("peer", "lightning:testnet");
      const { user, request } = composer({ onRequest: async () => "Mint unreachable" });
      await start(user, "lightning-testnet");
      await user.click(screen.getByTestId("payment-request"));
      expect(await screen.findByRole("alert")).toHaveTextContent("Mint unreachable");
      expect(sheet()).toBeInTheDocument();
      await user.click(screen.getByTestId("payment-request"));
      expect(request).toHaveBeenCalledTimes(2);
    });
  });
});

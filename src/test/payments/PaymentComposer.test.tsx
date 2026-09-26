import { act, screen, within } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkView, WalletInstanceView, WalletView } from "@ghostly/browser/shared/types";
import type { WalletNetwork } from "@ghostly/core";
import { PaymentComposer } from "../../components/PaymentComposer";
import { rememberRail, rememberedRail } from "../../lib/chatPayments";
import { fakeEngine, linkView, paymentView } from "../fakeEngine";
import { renderApp } from "../render";
import { arkReady, bitcoinSource, everyWallet, mint, REAL_MINT, reviewContext, reviewOf, target, TEST_MINT, usdtReady } from "./fixtures";

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
  onSend?: (amount: number, memo: string, network?: WalletNetwork) => Promise<string | null>;
  onRequest?: (amount: number, memo: string, method?: string, rail?: string, network?: WalletNetwork) => Promise<string | null>;
}

/** Where the app is: the composer navigates away to make a wallet. */
function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

/** The composer in a chat with "peer", whose name the chat shows as Alice. */
function open({ wallet = everyWallet(), link, balance = 1_000, withWallet = true, onSend, onRequest }: Open = {}) {
  // The chat and the wallet are there before the composer opens, as they are in the app.
  fakeEngine.setState({ links: [linkView(link)], wallet });
  const handlers = {
    onSend: vi.fn(onSend ?? (async () => null)),
    onRequest: vi.fn(onRequest ?? (async () => null)),
    onClose: vi.fn(),
  };
  const view = renderApp(
    <><PaymentComposer balance={balance} {...handlers} reviewContext={withWallet ? reviewContext() : undefined} contact="Alice" /><Where /></>,
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

describe("the amount", () => {
  it("keeps only digits in an amount of sats", async () => {
    const { user } = open({ withWallet: false });
    await user.type(amount(), "1a2.5b");
    expect(amount()).toHaveValue("125");
    expect(amount()).toHaveAccessibleName("Amount in sats");
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

  it("shows one card per wallet, each on its own network", () => {
    open();
    expect(screen.getAllByRole("radio").map((r) => r.dataset.testid)).toEqual([
      // Real money first, then test money: the two networks never mingle.
      "payment-card-cashu-mainnet", "payment-card-lightning-mainnet", "payment-card-bitcoin-mainnet",
      "payment-card-arkade-testnet", "payment-card-bark-testnet", "payment-card-spark-testnet", "payment-card-usdt-testnet",
    ]);
    // Every card says its network here, Mainnet too.
    expect(screen.getByTestId("payment-card-bitcoin-mainnet").querySelector("[data-testid=wallet-card-network]")).toHaveTextContent("Mainnet");
    expect(screen.getByTestId("payment-card-usdt-testnet").querySelector("[data-testid=wallet-card-network]")).toHaveTextContent("Testnet");
  });

  it("starts on the card used last time", () => {
    rememberRail("peer", "arkade:testnet");
    open();
    expect(card("arkade-testnet")).toHaveAttribute("aria-checked", "true");
    expect(card("cashu-mainnet")).toHaveAttribute("aria-checked", "false");
  });

  it("reads a remembered rail from before networks as that rail's first card", () => {
    // Both networks have a Cashu card: the old value "cashu" picks the first one, in the deck's order.
    rememberRail("peer", "cashu");
    open({ wallet: everyWallet({ mints: [mint(REAL_MINT, 500), mint(TEST_MINT, 500)], balance: 500 }) });
    expect(card("cashu-mainnet")).toHaveAttribute("aria-checked", "true");
    expect(card("cashu-testnet")).toHaveAttribute("aria-checked", "false");
  });

  it("reads a remembered old rail as its card on whichever network it is", () => {
    rememberRail("peer", "arkade");
    open();
    expect(card("arkade-testnet")).toHaveAttribute("aria-checked", "true");
    expect(card("cashu-mainnet")).toHaveAttribute("aria-checked", "false");
  });

  it("skips a remembered card that is off in this chat, for the first one that is on", () => {
    rememberRail("peer", "arkade:testnet");
    open({ link: { paymentMethods: { ...ALL_ON, cashu: false, arkade: false } } });
    expect(card("lightning-mainnet")).toHaveAttribute("aria-checked", "true");
  });

  it("starts on the first card that can be used, in the deck's order, not on one that is not set up", () => {
    // A Cashu wallet with no mint: Cashu and Lightning (through the mints) cannot be used; Ark is next.
    open({ wallet: everyWallet({ mints: [], balance: 0, wallets: [instance("cashu", "mainnet"), instance("lightning", "mainnet"), instance("arkade", "testnet")] }) });
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
    // A Cashu wallet with no mint yet, and an Ark wallet whose provider has not answered.
    open({ wallet: everyWallet({ mints: [], balance: 0, ark: undefined, wallets: [instance("cashu", "mainnet"), instance("arkade", "testnet")] }) });
    expect(card("cashu-mainnet")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("payment-use")).toBeDisabled();
    act(() => fakeEngine.update({ wallet: { ...fakeEngine.state.wallet, ark: arkReady() } }));
    expect(await screen.findByText("Use Ark")).toBeInTheDocument();
    expect(card("arkade-testnet")).toHaveAttribute("aria-checked", "true");
  });

  it("ignores a remembered value that is not a card", () => {
    rememberRail("peer", "paypal");
    open();
    expect(card("cashu-mainnet")).toHaveAttribute("aria-checked", "true");
  });

  it("turns over the card clicked, names its network on the back and remembers the wallet for next time", async () => {
    const { user } = open();
    await user.click(card("arkade-testnet"));
    expect(rememberedRail("peer")).toBe("arkade:testnet");
    const back = screen.getByTestId("payment-back");
    expect(back).toHaveAttribute("data-network", "testnet");
    expect(screen.getByTestId("payment-composer")).toHaveAttribute("data-network", "testnet");
    expect(within(back).getByText("Ark · Testnet")).toBeInTheDocument();
    expect(within(back).getByTestId("payment-back-network")).toHaveTextContent("Test money");
    expect(within(back).getByText("5,000 test sats · with Alice")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });

  it("names a Mainnet card on the back by its name alone", async () => {
    const { user } = open();
    await user.click(card("cashu-mainnet"));
    const back = screen.getByTestId("payment-back");
    expect(back).toHaveAttribute("data-network", "mainnet");
    expect(within(back).getByText("Cashu")).toBeInTheDocument();
    expect(within(back).getByTestId("payment-back-network")).toHaveTextContent("Real money");
    expect(within(back).getByText("1,000 sats · with Alice")).toBeInTheDocument();
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

  it("goes back from the amount to the cards", async () => {
    document.documentElement.dataset.reduceMotion = "true";
    const { user } = open();
    await user.click(screen.getByTestId("payment-use"));
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Choose another card" }));
    expect(await screen.findByRole("radiogroup", { name: "Pay with" })).toBeInTheDocument();
    expect(card("cashu-mainnet")).toHaveAttribute("aria-checked", "true");
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
    open({ link: { dataLink: "open", capabilities: { files: true, payments: true, methods: { ...ALL_ON, usdt: false } } } });
    expect(card("usdt-testnet")).toHaveAttribute("title", "Your contact does not accept USDT in this chat");
    expect(within(card("usdt-testnet")).getByText("Not accepted")).toBeInTheDocument();
  });

  it("does not hold what the contact accepts against them while the chat is not connected", () => {
    open({ link: { dataLink: "idle", capabilities: { files: true, payments: true, methods: { ...ALL_ON, usdt: false } } } });
    expect(card("usdt-testnet")).not.toHaveAttribute("aria-disabled");
  });

  describe("when the contact has no wallet of the card's network", () => {
    // Alice has Cashu on Mainnet only: a test sat must not go to her, nor be asked of her.
    const theirs = { cashu: ["mainnet"], lightning: ["mainnet"] } as const;
    const testCashu = () => everyWallet({ mints: [mint(TEST_MINT, 500)], balance: 500 });

    it("blocks the card and says which wallet the contact lacks", async () => {
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
      open({ wallet: testCashu(), link: { dataLink: "idle", capabilities: { files: true, payments: true, methods: ALL_ON, networks: theirs } } });
      expect(card("cashu-testnet")).not.toHaveAttribute("aria-disabled");
    });

    it("lets every network meet when the contact said none (an older app)", () => {
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

  it("sends ecash straight away when there is no wallet to review it with", async () => {
    const { user, onSend, onClose } = open({ withWallet: false });
    await user.type(amount(), "21");
    await user.type(screen.getByRole("textbox", { name: "What for? (optional)" }), "tip");
    await user.click(send());
    // No card, so no network: the engine sends from the wallet it would.
    expect(onSend).toHaveBeenCalledWith(21, "tip", undefined);
    expect(onClose).toHaveBeenCalled();
  });

  it("shows why a send failed and stays open", async () => {
    const { user, onClose } = open({ withWallet: false, onSend: async () => "Not enough sats at that mint" });
    await user.type(amount(), "21");
    await user.click(send());
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

  it("offers both, each named by its network", () => {
    open({ wallet: both() });
    expect(card("cashu-mainnet")).toBeInTheDocument();
    expect(card("cashu-testnet")).toBeInTheDocument();
    expect(card("lightning-mainnet")).toBeInTheDocument();
    expect(card("lightning-testnet")).toBeInTheDocument();
  });

  it.each([
    ["mainnet", "cashu-mainnet", "bitcoin", REAL_MINT],
    ["testnet", "cashu-testnet", "cashu-test", TEST_MINT],
  ] as const)("sends from the %s card on its own network, from its own mint", async (network, id, chain, provider) => {
    const view = open({ wallet: both(), balance: 10_000 });
    view.engine.on("preparePayment", reviewOf);
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
    // Real money comes first in the deck: the Cashu card of these mints' network is picked by hand.
    await view.user.click(screen.getByTestId(`payment-card-cashu-${mints[0].url === TEST_MINT ? "testnet" : "mainnet"}`));
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
    expect(send()).toBeDisabled();
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
    expect(await screen.findByRole("alert")).toHaveTextContent("Your contact's app did not answer.");
    expect(send()).toHaveTextContent("Send");
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

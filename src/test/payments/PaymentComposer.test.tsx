import { act, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkView, WalletView } from "@ghostly/browser/shared/types";
import { PaymentComposer } from "../../components/PaymentComposer";
import { fakeEngine, linkView, paymentView } from "../fakeEngine";
import { renderApp } from "../render";
import { arkReady, bitcoinSource, everyWallet, mint, REAL_MINT, reviewContext, reviewOf, target, TEST_MINT, usdtReady } from "./fixtures";

const RAIL_KEY = "ghostly-payment-rail";
const OTHER_MINT = "https://mint2.example.com";
const ALL_ON = { cashu: true, lightning: true, arkade: true, bark: true, bitcoin: true, usdt: true };

interface Open {
  wallet?: Partial<WalletView>;
  link?: Partial<LinkView>;
  balance?: number;
  /** Without it the composer has no wallet of its own: only the back, and Send goes through `onSend`. */
  withWallet?: boolean;
  onSend?: (amount: number, memo: string) => Promise<string | null>;
  onRequest?: (amount: number, memo: string, method?: string) => Promise<string | null>;
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
    <PaymentComposer balance={balance} {...handlers} reviewContext={withWallet ? reviewContext() : undefined} contact="Alice" />,
  );
  return { ...view, ...handlers };
}

const amount = () => screen.getByTestId("payment-amount");
const send = () => screen.getByTestId("payment-send");
const request = () => screen.getByTestId("payment-request");
const card = (rail: string) => screen.getByTestId(`payment-card-${rail}`);
const hint = () => screen.getByText((_, el) => !!el?.classList.contains("payment-back-hint"));

describe("the amount", () => {
  it("keeps only digits in an amount of sats", async () => {
    const { user } = open({ withWallet: false });
    await user.type(amount(), "1a2.5b");
    expect(amount()).toHaveValue("125");
    expect(amount()).toHaveAccessibleName("Amount in sats");
  });

  it("takes decimals for USDT and requests in the token's smallest units", async () => {
    localStorage.setItem(RAIL_KEY, "usdt");
    const { user, onRequest } = open();
    await user.click(screen.getByTestId("payment-use"));
    await user.type(amount(), "1.5x");
    expect(amount()).toHaveValue("1.5");
    await user.type(screen.getByRole("textbox", { name: "What for? (optional)" }), "coffee");
    await user.click(request());
    expect(onRequest).toHaveBeenCalledWith(1_500_000, "coffee", "usdt");
  });

  it("refuses more USDT decimals than the token has, without asking for anything", async () => {
    localStorage.setItem(RAIL_KEY, "usdt");
    const { user, onRequest } = open();
    await user.click(screen.getByTestId("payment-use"));
    await user.type(amount(), "1.1234567");
    await user.click(request());
    expect(await screen.findByRole("alert")).toHaveTextContent("Use at most 6 decimal places");
    expect(onRequest).not.toHaveBeenCalled();
  });

  it.each([
    ["Cashu on Mainnet", "cashu", { mode: "mainnet" as const }, "sats"],
    ["Cashu in Testnet", "cashu", { mode: "testnet" as const }, "test sats"],
    ["Lightning in Testnet", "lightning", { mode: "testnet" as const }, "test sats"],
    ["Ark on Mutinynet", "arkade", { ark: arkReady({ network: "mutinynet" }) }, "test sats"],
    ["Ark on Bitcoin", "arkade", { ark: arkReady({ network: "bitcoin" }) }, "sats"],
    ["Bark on signet", "bark", {}, "test sats"],
    ["on-chain on regtest", "bitcoin", { bitcoin: bitcoinSource({ network: "regtest" }) }, "test sats"],
    ["on-chain on Bitcoin", "bitcoin", { bitcoin: bitcoinSource({ network: "bitcoin" }) }, "sats"],
    ["USDT on Sepolia", "usdt", { usdt: usdtReady({ chainId: 11155111 }) }, "TEST-USDT"],
    ["USDT on Ethereum", "usdt", { usdt: usdtReady({ chainId: 1 }) }, "USDT"],
  ])("counts %s in the right unit", async (_, rail, wallet, unit) => {
    localStorage.setItem(RAIL_KEY, rail);
    const { user } = open({ wallet: everyWallet(wallet) });
    await user.click(screen.getByTestId("payment-use"));
    expect(amount()).toHaveAccessibleName(`Amount in ${unit}`);
  });
});

describe("the cards", () => {
  it("starts on Cashu when no card was used before", () => {
    open();
    expect(screen.getByRole("radiogroup", { name: "Pay with" })).toBeInTheDocument();
    expect(card("cashu")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("payment-use")).toHaveTextContent("Use Cashu");
  });

  it("starts on the card used last time", () => {
    localStorage.setItem(RAIL_KEY, "arkade");
    open();
    expect(card("arkade")).toHaveAttribute("aria-checked", "true");
    expect(card("cashu")).toHaveAttribute("aria-checked", "false");
  });

  it("skips a remembered card that is off in this chat, for the first one that is on", () => {
    localStorage.setItem(RAIL_KEY, "arkade");
    open({ link: { paymentMethods: { ...ALL_ON, cashu: false, arkade: false } } });
    expect(card("lightning")).toHaveAttribute("aria-checked", "true");
  });

  it("ignores a remembered value that is not a card", () => {
    localStorage.setItem(RAIL_KEY, "paypal");
    open();
    expect(card("cashu")).toHaveAttribute("aria-checked", "true");
  });

  it("turns over the card clicked and remembers it for next time", async () => {
    const { user } = open();
    await user.click(card("arkade"));
    expect(localStorage.getItem(RAIL_KEY)).toBe("arkade");
    const back = screen.getByTestId("payment-back");
    expect(within(back).getByText("Ark")).toBeInTheDocument();
    expect(within(back).getByText("5,000 test sats · with Alice")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });

  it("moves along the cards with the arrow keys and turns the chosen one over with Enter", async () => {
    const { user } = open();
    // The keyboard starts on the chosen card.
    expect(card("cashu")).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(card("lightning")).toHaveAttribute("aria-checked", "true");
    expect(card("lightning")).toHaveFocus();
    // Moving only selects: nothing is remembered until a card is turned over.
    expect(localStorage.getItem(RAIL_KEY)).toBeNull();
    await user.keyboard("{Enter}");
    expect(within(screen.getByTestId("payment-back")).getByText("Lightning")).toBeInTheDocument();
    expect(localStorage.getItem(RAIL_KEY)).toBe("lightning");
  });

  it("goes back from the amount to the cards", async () => {
    document.documentElement.dataset.reduceMotion = "true";
    const { user } = open();
    await user.click(screen.getByTestId("payment-use"));
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Choose another card" }));
    expect(await screen.findByRole("radiogroup", { name: "Pay with" })).toBeInTheDocument();
    expect(card("cashu")).toHaveAttribute("aria-checked", "true");
  });

  it("closes on Escape", async () => {
    const { user, onClose } = open();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("a card that cannot be used here", () => {
  it("says a wallet that is not ready yet is still connecting, and is not turned over", async () => {
    const { user } = open({ wallet: everyWallet({ ark: { configured: false, locked: true, balance: 0 } }) });
    expect(card("arkade")).toHaveAttribute("aria-disabled", "true");
    expect(card("arkade")).toHaveAttribute("title", "Ark is connecting…");
    await user.click(card("arkade"));
    // It comes up, to say why, but stays a card.
    expect(card("arkade")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Ark is connecting…", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByTestId("payment-use")).toBeDisabled();
    expect(localStorage.getItem(RAIL_KEY)).toBeNull();
  });

  it("says a way of paying is off in this chat", () => {
    open({ link: { paymentMethods: { ...ALL_ON, bark: false } } });
    expect(card("bark")).toHaveAttribute("title", "Bark is off in this chat");
    expect(within(card("bark")).getByText("Off here")).toBeInTheDocument();
  });

  it("says the contact does not accept a way of paying", () => {
    open({ link: { dataLink: "open", capabilities: { files: true, payments: true, methods: { ...ALL_ON, usdt: false } } } });
    expect(card("usdt")).toHaveAttribute("title", "Your contact does not accept USDT in this chat");
    expect(within(card("usdt")).getByText("Not accepted")).toBeInTheDocument();
  });

  it("does not hold what the contact accepts against them while the chat is not connected", () => {
    open({ link: { dataLink: "idle", capabilities: { files: true, payments: true, methods: { ...ALL_ON, usdt: false } } } });
    expect(card("usdt")).not.toHaveAttribute("aria-disabled");
  });
});

describe("request and send", () => {
  it("requests with a Lightning invoice but sends nothing on Lightning", async () => {
    localStorage.setItem(RAIL_KEY, "lightning");
    const { user, onRequest, onClose } = open();
    await user.click(screen.getByTestId("payment-use"));
    await user.type(amount(), "50");
    expect(send()).toBeDisabled();
    expect(send()).toHaveAttribute("title", "To pay on this card, tap Pay on your contact's request");
    await user.click(request());
    // A Lightning request is a Cashu request: it carries the invoice.
    expect(onRequest).toHaveBeenCalledWith(50, "", "cashu");
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
    localStorage.setItem(RAIL_KEY, "arkade");
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
    expect(onSend).toHaveBeenCalledWith(21, "tip");
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

describe("sending Cashu from the chat's wallet", () => {
  async function sendCashu(mints: ReturnType<typeof mint>[], sats: string) {
    const view = open({ wallet: everyWallet({ mints, balance: mints.reduce((s, m) => s + m.balance, 0) }), balance: 10_000 });
    view.engine.on("preparePayment", reviewOf);
    await view.user.click(screen.getByTestId("payment-use"));
    await view.user.type(amount(), sats);
    await view.user.type(screen.getByRole("textbox", { name: "What for? (optional)" }), "pizza");
    await view.user.click(send());
    return view;
  }

  it("reviews test ecash from the test mint, as the Cashu test network", async () => {
    const { engine, onSend } = await sendCashu([mint(TEST_MINT, 500)], "30");
    expect(await screen.findByRole("region", { name: "Payment review" })).toBeInTheDocument();
    expect(engine.callsTo("preparePayment")).toEqual([{
      target: { method: "cashu", network: "cashu-test", provider: TEST_MINT, address: "peer", asset: "BTC", unit: "sat", expiresAt: expect.any(Number) },
      amount: 30, feeCap: 10, payee: "peer", linkId: "link-1", memo: "pizza",
    }]);
    // With a wallet to review it, nothing goes out before the review is approved.
    expect(onSend).not.toHaveBeenCalled();
  });

  it("pays real sats from a real mint", async () => {
    const { engine } = await sendCashu([mint(REAL_MINT, 500)], "30");
    await screen.findByRole("region", { name: "Payment review" });
    expect(engine.callsTo("preparePayment")[0].target).toMatchObject({ network: "bitcoin", provider: REAL_MINT });
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

  async function ask(rail: string, typed: string) {
    localStorage.setItem(RAIL_KEY, rail);
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
    ["arkade", "250", 250],
    ["bark", "250", 250],
    ["bitcoin", "250", 250],
    ["usdt", "2.5", 2_500_000],
  ])("on %s, asks the contact's app for an address first", async (rail, typed, units) => {
    const { engine } = await ask(rail, typed);
    expect(engine.callsTo("askToPay")).toEqual([{ linkId: "link-1", amount: units, method: rail, memo: "lunch", timestamp: expect.any(Number) }]);
    expect(send()).toBeDisabled();
    expect(request()).toBeDisabled();
    expect(engine.callsTo("preparePayment")).toEqual([]);
  });

  it.each([
    ["arkade", target({ method: "arkade" }), 10],
    ["bitcoin", target({ method: "bitcoin", provider: "onchain", address: "bcrt1qpayee" }), 2_000],
    ["usdt", target({ method: "usdt", network: "sepolia", asset: "TEST-USDT", unit: "token-base", decimals: 6 }), 10 ** 15],
  ])("on %s, reviews the request the contact's app answers with", async (rail, answer, feeCap) => {
    const { engine } = await ask(rail, "3");
    act(() => engine.update({ payments: { "req-1": paymentView({ id: "req-1", kind: "request", direction: "in", ask: "ask-1", amount: 3, target: answer }) } }));
    tick(400);
    expect(await screen.findByRole("region", { name: "Payment review" })).toBeInTheDocument();
    expect(engine.callsTo("preparePayment")).toEqual([{ target: answer, amount: 3, feeCap, payee: "peer", linkId: "link-1", requestId: "req-1" }]);
  });

  it("does not take a request that answers another ask", async () => {
    const { engine } = await ask("arkade", "3");
    act(() => engine.update({ payments: { "req-2": paymentView({ id: "req-2", kind: "request", direction: "in", ask: "ask-other", target: target() }) } }));
    tick(2_000);
    expect(engine.callsTo("preparePayment")).toEqual([]);
    expect(send()).toHaveTextContent("Asking for an address…");
  });

  it("gives up when the contact's app does not answer", async () => {
    await ask("arkade", "3");
    tick(45_600);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your contact's app did not answer.");
    expect(send()).toHaveTextContent("Send");
    expect(send()).toBeEnabled();
  });

  it("shows why the contact could not be asked", async () => {
    localStorage.setItem(RAIL_KEY, "bark");
    const { user, engine } = open();
    engine.on("askToPay", () => { throw new Error("Your contact is offline"); });
    await user.click(screen.getByTestId("payment-use"));
    await user.type(amount(), "3");
    await user.click(send());
    expect(await screen.findByRole("alert")).toHaveTextContent("Your contact is offline");
    expect(send()).toHaveTextContent("Send");
  });
});

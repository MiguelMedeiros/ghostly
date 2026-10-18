import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { PaymentReview as Review } from "@ghostly/core";
import type { NetworkWalletsView } from "@ghostly/browser/shared/types";
import { MessageBubble } from "../../components/MessageBubble";
import { PaymentBubble } from "../../components/PaymentBubble";
import { PaymentReview } from "../../components/PaymentReview";
import { servicesPlatform, type WalletPlatform } from "../../lib/platform";
import { fakeEngine, linkView, paymentView } from "../fakeEngine";
import { renderApp } from "../render";
import { lightningSource, liveMainnetInvoice, mint, REAL_MINT, REGTEST_INVOICE, reviewOf, TEST_MINT } from "./fixtures";
import { bcrt1q } from "./moneyFormatFixtures";

// covers: payments.lightning.invoice-card, payments.cashu.token-card, payments.chat.review, payments.lightning.request, payments.cashu.reclaim, payments.money.onchain-card

/**
 * The chat's money cards from the keyboard: the button pressed keeps the focus while it works (busy, not disabled: a
 * disabled one drops it to the page in Chromium) and after a refusal, a press while busy does nothing, and each step
 * that takes the place of a button takes the focus.
 */
const later = <T,>() => { let answer!: (value: T) => void, refuse!: (e: Error) => void; const promise = new Promise<T>((resolve, reject) => { answer = resolve; refuse = reject; }); return { promise, answer, refuse }; };
const busy = (button: HTMLElement) => {
  expect(button).toHaveAttribute("aria-busy", "true");
  expect(button).toHaveAttribute("aria-disabled", "true");
  expect(button).toBeEnabled();
  expect(button).toHaveFocus();
};
const done = (button: HTMLElement) => waitFor(() => expect(button).not.toHaveAttribute("aria-busy"));
const message = (text: string) => ({ id: "m1", text, sender: "peer", timestamp: Date.now(), status: "delivered" }) as never;
const press = async (user: { keyboard(keys: string): Promise<void> }, button: HTMLElement) => { button.focus(); await user.keyboard("{Enter}"); };

beforeEach(() => fakeEngine.reset());

describe("a Lightning invoice in a message", () => {
  const invoice = liveMainnetInvoice(2_100);
  const quote = { quote: "melt-1", mint: TEST_MINT, amount: 2_100, feeReserve: 3 };
  const show = () => {
    fakeEngine.setState({ links: [linkView()], wallet: { mints: [mint(TEST_MINT, 5_000)], balance: 5_000 } });
    return renderApp(<MessageBubble message={message(invoice)} peerPubKey="peer" />);
  };

  it("Pay and the quoted Pay are busy where pressed and keep the keys after a refusal; the quote and Cancel hand them on", async () => {
    const { user, engine } = show();
    let quoted = later<typeof quote>(), quotes = 0;
    const paid = later<{ paid: boolean }>();
    engine.on("walletQuoteInvoice", () => { quotes++; return quoted.promise; }).on("walletPayQuote", () => paid.promise);
    const pay = screen.getByTestId("invoice-pay");
    await press(user, pay);
    busy(pay);
    await user.keyboard("{Enter}");
    quoted.refuse(new Error("The mint did not answer"));
    await done(pay);
    expect(pay).toHaveFocus();
    expect(quotes).toBe(1);

    quoted = later();
    await user.keyboard("{Enter}");
    quoted.answer(quote);
    const confirm = await screen.findByTestId("invoice-confirm");
    await waitFor(() => expect(confirm).toHaveFocus());
    await user.keyboard("{Enter}");
    busy(confirm);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    paid.refuse(new Error("Route not found"));
    await done(confirm);
    expect(confirm).toHaveFocus();

    await user.tab();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("invoice-pay")).toHaveFocus();
  });

  it("Paid takes the keys from the Pay that paid it", async () => {
    const { user, engine } = show();
    engine.on("walletQuoteInvoice", () => quote).on("walletPayQuote", () => ({ paid: true }));
    await press(user, screen.getByTestId("invoice-pay"));
    await press(user, await screen.findByTestId("invoice-confirm"));
    await waitFor(() => expect(screen.getByTestId("invoice-paid")).toHaveFocus());
  });
});

describe("an ecash token in a message", () => {
  it("Redeem is busy where pressed and keeps the keys after a refusal; Redeemed takes them", async () => {
    fakeEngine.setState({ links: [linkView()] });
    fakeEngine.on("walletInspectCashu", () => ({ inspection: { kind: "token", amount: 1008, unit: "sat", mint: "https://mint.example.com", accepted: true } }));
    const { user, engine } = renderApp(<MessageBubble message={message(`cashuBa${"o".repeat(60)}`)} peerPubKey="peer" />);
    let received = later<{ amount: number }>();
    engine.on("walletReceiveToken", () => received.promise);
    const redeem = within(await screen.findByTestId("cashu-token-bubble")).getByTestId("token-redeem");
    await press(user, redeem);
    busy(redeem);
    received.refuse(new Error("The mint did not answer"));
    await done(redeem);
    expect(redeem).toHaveFocus();

    received = later();
    await user.keyboard("{Enter}");
    received.answer({ amount: 1008 });
    await waitFor(() => expect(screen.getByTestId("token-redeemed")).toHaveFocus());
  });
});

describe("a request in the chat", () => {
  const show = (payment: Parameters<typeof paymentView>[0], wallet: object) => {
    fakeEngine.setState({ links: [linkView()], wallet, payments: { "pay-1": paymentView(payment) } });
    return renderApp(<PaymentBubble paymentId="pay-1" peerPubKey="peer" fallbackText="[a payment]" />);
  };
  const reviewButton = () => screen.getByRole("button", { name: /^(Review payment|Preparing…)$/ });

  it("Review payment is busy where pressed and keeps the keys after a refusal; the review it opens takes them", async () => {
    const { user, engine } = show({ kind: "request", direction: "in", mints: [REAL_MINT] }, { mints: [mint(REAL_MINT, 900)] });
    let prepared = later<Review>();
    engine.on("preparePayment", () => prepared.promise);
    const open = reviewButton();
    await press(user, open);
    busy(open);
    prepared.refuse(new Error("The mint did not answer"));
    await done(open);
    expect(open).toHaveFocus();

    prepared = later();
    await user.keyboard("{Enter}");
    prepared.answer(reviewOf(engine.callsTo("preparePayment")[1]));
    await waitFor(() => expect(screen.getByRole("heading", { name: /Review payment/ })).toHaveFocus());
  });

  it("over Lightning: the review takes the keys, Approve is busy where pressed and keeps them after a refusal, Cancel hands them back", async () => {
    const { user, engine } = show({ kind: "request", direction: "in", amount: 250_000, invoice: REGTEST_INVOICE }, { lightning: lightningSource({ mode: "testnet", providerId: "fake-lightning" }) });
    const paid = later<void>();
    engine.on("walletQuoteInvoice", () => ({ quote: "q-1", mint: "", amount: 250_000, feeReserve: 5, source: "fake-lightning" })).on("payRequest", () => paid.promise);
    await press(user, reviewButton());
    await waitFor(() => expect(screen.getByTestId("payment-lightning-line")).toHaveFocus());
    const approve = screen.getByRole("button", { name: "Approve payment" });
    await press(user, approve);
    busy(approve);
    paid.refuse(new Error("No route"));
    await done(approve);
    expect(approve).toHaveFocus();
    await user.tab();
    await user.keyboard("{Enter}");
    expect(reviewButton()).toHaveFocus();
  });

  it("Take it back is busy where pressed and keeps the keys after a refusal", async () => {
    const { user, engine } = show({ kind: "payment", direction: "out", state: "pending" }, { mints: [mint(REAL_MINT, 0)] });
    const taken = later<void>();
    engine.on("reclaimPayment", () => taken.promise);
    const back = screen.getByRole("button", { name: "Take it back" });
    await press(user, back);
    busy(back);
    taken.refuse(new Error("Already redeemed"));
    await done(back);
    expect(back).toHaveFocus();
  });
});

describe("a payment's review", () => {
  const pending = { method: "cashu", network: "cashu-test", provider: TEST_MINT, asset: "BTC", unit: "sat", address: "pay-1", expiresAt: Date.now() + 60_000, id: "review-1", payee: "peer", amount: 30, fee: 2, feeCap: 10, createdAt: 0, state: "pending" } as Review;

  it("Approve and Cancel are busy where pressed, the other waits, and the keys stay after a refusal", async () => {
    const approved = later<Review>();
    const cancelled = later<Review>();
    const wallet: WalletPlatform = Object.assign(Object.create(servicesPlatform!.wallet), { approvePayment: () => approved.promise, cancelPayment: () => cancelled.promise });
    const { user } = renderApp(<PaymentReview review={pending} wallet={wallet} onClose={() => {}} />);
    const approve = screen.getByTestId("review-approve"), cancel = screen.getByRole("button", { name: "Cancel" });
    await press(user, approve);
    busy(approve);
    expect(cancel).toBeDisabled();
    approved.refuse(new Error("The mint did not answer"));
    await done(approve);
    expect(approve).toHaveFocus();

    await press(user, cancel);
    busy(cancel);
    expect(approve).toBeDisabled();
    cancelled.refuse(new Error("The mint did not answer"));
    await done(cancel);
    expect(cancel).toHaveFocus();
  });
});

describe("a pasted bitcoin: link", () => {
  const regtest = { status: "ready", providerId: "bdk", label: "BDK wallet", network: "regtest", balance: 100_000, history: [] } as unknown as NonNullable<NetworkWalletsView["bitcoin"]>;
  const empty = (): NetworkWalletsView => ({ mints: [], balance: 0, history: [], feesPaid: 0 });

  it("Pay opens a form that takes the keys; its Review is busy where pressed and keeps them after a refusal; Cancel hands them back", async () => {
    fakeEngine.setState({ wallet: { networks: { mainnet: empty(), testnet: { ...empty(), bitcoin: regtest } } } as never });
    const prepared = later<Review>();
    fakeEngine.on("preparePayment", () => prepared.promise);
    const { user } = renderApp(<MessageBubble message={message(`bitcoin:${bcrt1q()}?amount=0.0002`)} peerPubKey="peer" />);
    await press(user, screen.getByTestId("onchain-pay"));
    expect(screen.getByRole("textbox", { name: /fee/i })).toHaveFocus();
    const review = screen.getByTestId("money-review");
    await press(user, review);
    busy(review);
    prepared.refuse(new Error("Fee too high"));
    await done(review);
    expect(review).toHaveFocus();
    await user.tab();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("onchain-pay")).toHaveFocus();
  });
});

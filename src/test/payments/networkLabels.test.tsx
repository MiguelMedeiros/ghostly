import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LinkView, PaymentView, WalletView } from "@ghostly/browser/shared/types";
import { MessageBubble } from "../../components/MessageBubble";
import { PaymentBubble } from "../../components/PaymentBubble";
import { fakeEngine, linkView, paymentView } from "../fakeEngine";
import { renderApp } from "../render";
import { MAINNET_INVOICE, mint, REAL_MINT, reviewOf, target, TEST_MINT } from "./fixtures";

// covers: payments.chat.networks, payments.chat.review, payments.cashu.test-sats, payments.lightning.invoice-card

/**
 * Wherever money moves, the network is said in words: "Test money" or "Real money" on the bubble, the review and an
 * invoice, test sats as the unit. Real money asks once more before it goes; test money goes on Approve. A request
 * of a network this profile has no wallet on says so, and offers no Review.
 */

const both = (): Partial<WalletView> => ({ mints: [mint(REAL_MINT, 1_000), mint(TEST_MINT, 1_000)] });
function show(payment: Partial<PaymentView>, { wallet = both(), link }: { wallet?: Partial<WalletView>; link?: Partial<LinkView> } = {}) {
  fakeEngine.setState({ links: [linkView(link)], wallet, payments: { "pay-1": paymentView(payment) } });
  return renderApp(<PaymentBubble paymentId="pay-1" peerPubKey="peer" fallbackText="[a payment]" />);
}
const incomingRequest = (patch: Partial<PaymentView> = {}) => ({ kind: "request" as const, direction: "in" as const, ...patch });
const review = () => screen.findByRole("region", { name: "Payment review" });

describe("the bubble names its money", () => {
  it.each([
    ["a Testnet request", incomingRequest({ network: "testnet", mints: [TEST_MINT] }), "Test money"],
    ["a Mainnet request", incomingRequest({ network: "mainnet", mints: [REAL_MINT] }), "Real money"],
    ["a payment of test sats sent", { kind: "payment" as const, direction: "out" as const, network: "testnet" as const, amount: 21 }, "Test money"],
    ["a payment of real sats received", { kind: "payment" as const, direction: "in" as const, network: "mainnet" as const, amount: 21 }, "Real money"],
  ])("%s wears the words, not only a colour", (_what, payment, words) => {
    show(payment);
    const tag = screen.getByTestId("payment-network");
    expect(tag).toHaveTextContent(words);
    expect(tag).toHaveAttribute("data-network", words === "Test money" ? "testnet" : "mainnet");
  });
});

describe("the review says which money, and real money asks once more", () => {
  it("test money: Test money on the review, test sats as the unit, and Approve sends at once", async () => {
    const { user, engine } = show(incomingRequest({ amount: 5_000, target: target({ method: "bitcoin", network: "signet", provider: "onchain", address: "tb1qpayee" }) }));
    engine.on("preparePayment", reviewOf);
    engine.on("approvePayment", (params) => ({ ...reviewOf({ target: target({ method: "bitcoin", network: "signet", provider: "onchain", address: "tb1qpayee" }), amount: 5_000, feeCap: 2_000, payee: "peer", linkId: "link-1" }), id: params.id, state: "submitted" }));
    await user.click(screen.getByRole("button", { name: "Review payment" }));
    const panel = await review();
    expect(within(panel).getByTestId("review-network")).toHaveTextContent("Test money");
    expect(within(panel).getByTestId("review-money")).toHaveTextContent("worth nothing");
    expect(panel).toHaveTextContent("5,000 test sats");
    await user.click(within(panel).getByTestId("review-approve"));
    expect(screen.queryByTestId("review-mainnet-confirm")).not.toBeInTheDocument();
    expect(engine.callsTo("approvePayment")).toEqual([{ id: "review-1" }]);
  });

  it("real money: Real money on the review, then a confirmation in words; Back sends nothing, Send real money does", async () => {
    const onchain = target({ method: "bitcoin", network: "bitcoin", provider: "onchain", address: "bc1qpayee" });
    const { user, engine } = show(incomingRequest({ amount: 5_000, network: "mainnet", target: onchain }));
    engine.on("preparePayment", reviewOf);
    engine.on("approvePayment", (params) => ({ ...reviewOf({ target: onchain, amount: 5_000, feeCap: 2_000, payee: "peer", linkId: "link-1" }), id: params.id, state: "submitted" }));
    await user.click(screen.getByRole("button", { name: "Review payment" }));
    const panel = await review();
    expect(within(panel).getByTestId("review-network")).toHaveTextContent("Real money");
    expect(within(panel).getByTestId("review-money")).toHaveTextContent("Real money: it leaves your wallet once you confirm.");
    expect(panel).toHaveTextContent("5,000 sats");
    expect(panel).not.toHaveTextContent("test sats");
    await user.click(within(panel).getByTestId("review-approve"));
    const confirm = within(panel).getByTestId("review-mainnet-confirm");
    expect(confirm).toHaveTextContent("Real money. This sends 5,000 sats that cannot be taken back once it settles. Nothing has gone out yet.");
    expect(engine.callsTo("approvePayment")).toEqual([]);
    await user.click(within(confirm).getByRole("button", { name: "Back" }));
    expect(screen.queryByTestId("review-mainnet-confirm")).not.toBeInTheDocument();
    expect(engine.callsTo("approvePayment")).toEqual([]);
    await user.click(within(panel).getByTestId("review-approve"));
    await user.click(within(panel).getByTestId("review-confirm-send"));
    expect(engine.callsTo("approvePayment")).toEqual([{ id: "review-1" }]);
    expect(await within(panel).findByTestId("review-status")).toHaveTextContent("submitted");
  });
});

describe("a request of a network this profile has no wallet on", () => {
  it("says test money is asked for, offers no Review, and still lets another wallet pay it", () => {
    const onchain = target({ method: "bitcoin", network: "signet", provider: "onchain", address: "tb1qpayee" });
    show(incomingRequest({ amount: 5_000, network: "testnet", target: onchain }), { wallet: { mints: [mint(REAL_MINT, 1_000)] } });
    expect(screen.getByTestId("payment-network-missing")).toHaveTextContent("Test money is asked for (test sats), and you have no Testnet wallet to pay it from. Make one under Wallets, or ask for real money instead.");
    expect(screen.queryByRole("button", { name: "Review payment" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pay with another wallet" })).toBeInTheDocument();
  });

  it("says real money is asked for when only a Testnet wallet is there", () => {
    show(incomingRequest({ amount: 5_000, network: "mainnet", mints: [REAL_MINT] }), { wallet: { mints: [mint(TEST_MINT, 1_000)] } });
    expect(screen.getByTestId("payment-network-missing")).toHaveTextContent("Real money is asked for (sats), and you have no Mainnet wallet to pay it from.");
    expect(screen.queryByRole("button", { name: "Review payment" })).not.toBeInTheDocument();
  });

  it("with a wallet of that network, the Review is there and the words are not", () => {
    show(incomingRequest({ amount: 5_000, network: "mainnet", mints: [REAL_MINT] }));
    expect(screen.queryByTestId("payment-network-missing")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review payment" })).toBeInTheDocument();
  });
});

describe("a Lightning invoice in a message", () => {
  const invoiceMessage = (wallet: Partial<WalletView>) => {
    fakeEngine.setState({ links: [linkView()], wallet });
    return renderApp(<MessageBubble message={{ id: "m1", text: MAINNET_INVOICE, sender: "peer", timestamp: Date.now(), status: "delivered" } as never} peerPubKey="peer" />);
  };

  it("names real money on a Mainnet invoice, and pays it with a Mainnet Lightning wallet", () => {
    invoiceMessage(both());
    const card = screen.getByTestId("invoice-bubble");
    expect(within(card).getByTestId("invoice-network")).toHaveTextContent("Real money");
    expect(card).not.toHaveTextContent("you have no");
    // The fixture invoice is a real one, long expired: Pay is offered only while an invoice can still be paid.
    if (!card.textContent?.includes("Expired")) expect(within(card).getByTestId("invoice-pay")).toBeInTheDocument();
  });

  it("with only a Testnet wallet, says in words there is no Mainnet Lightning wallet to pay it from, and offers no Pay", () => {
    invoiceMessage({ mints: [mint(TEST_MINT, 1_000)] });
    const card = screen.getByTestId("invoice-bubble");
    expect(card).toHaveTextContent("Real money: you have no Mainnet Lightning wallet to pay it from");
    expect(within(card).queryByTestId("invoice-pay")).not.toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });
});

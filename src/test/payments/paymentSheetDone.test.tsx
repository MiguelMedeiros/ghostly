import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletView } from "@ghostly/browser/shared/types";
import { MessageInput } from "../../components/MessageInput";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { rememberRail } from "../../lib/chatPayments";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { everyWallet, mint, REAL_MINT, reviewContext, reviewOf, TEST_MINT } from "./fixtures";

// covers: payments.chat.cards, payments.chat.review, payments.cashu.send, payments.cashu.request, payments.mainnet-confirm

/**
 * A payment sent or a request made from the chat's sheet ends there: the sheet closes, the chat is back with the
 * keyboard on the message field, and the chat's bubble shows how it goes. A failure keeps the sheet, with its error
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

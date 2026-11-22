import { screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { PaymentReview as Review } from "@ghostly/core";
import { MessageBubble } from "../../components/MessageBubble";
import { PaymentReview } from "../../components/PaymentReview";
import { servicesPlatform, type WalletPlatform } from "../../lib/platform";
import { fakeEngine, linkView, paymentView } from "../fakeEngine";
import { renderApp, type AppRenderOptions } from "../render";
import { mint, reviewOf, TEST_MINT } from "./fixtures";

// covers: payments.chat.review, groups.payments.member
describe("the review of a Cashu payment from the chat", () => {
  /**
   * A Cashu payment's review says whom it goes to. Its address is no place: paying a contact's request it was the
   * request's own id ("Destination ixRP7LArS6TzgrVr"), which names nobody. The chat's name for the contact goes there,
   * or in a group the name the member gave themselves.
   */
  function requestFrom(props: { contactName?: string; nick?: string }) {
    fakeEngine.setState({ links: [linkView()], wallet: { mints: [mint(TEST_MINT, 900)] }, payments: { "pay-1": paymentView({ kind: "request", direction: "in", mints: [TEST_MINT] }) } });
    const view = renderApp(<MessageBubble message={{ id: "m1", text: "[a payment]", sender: "peer", timestamp: 1, paymentId: "pay-1", ...(props.nick ? { nick: props.nick } : {}) }} peerPubKey="peer" contactName={props.contactName} />);
    view.engine.on("preparePayment", reviewOf);
    return view;
  }

  it.each([
    ["a 1:1 chat", { contactName: "Alice" }, "Alice"],
    ["a group", { nick: "Carol" }, "Carol"],
    // A contact the chat has no name for is "your contact", as the payment sheet's review says.
    ["a 1:1 chat with a contact with no name", { contactName: "" }, "your contact"],
  ])("names the contact as its destination in %s, not the request's id", async (_, props, name) => {
    const { user } = requestFrom(props);
    await user.click(screen.getByRole("button", { name: "Review payment" }));
    const review = await screen.findByRole("region", { name: "Payment review" });
    expect(within(review).getByTestId("review-destination")).toHaveTextContent(name);
    expect(review).not.toHaveTextContent("pay-1");
  });
});

// covers: payments.chat.review
describe("the focus around a payment review", () => {
  /**
   * A payment's review takes the place of the button that opened it (a request bubble's Review payment), and after
   * Approve its row of buttons changes: the focus goes to its title each time, not to the page, so the keys go on from
   * the review and a screen reader says what it is.
   */
  const pending: Review = {
    method: "cashu", network: "cashu-test", provider: TEST_MINT, asset: "BTC", unit: "sat", address: "pay-1", expiresAt: Date.now() + 60_000,
    id: "review-1", payee: "peer", amount: 30, fee: 2, feeCap: 10, createdAt: 0, state: "pending",
  } as Review;
  const wallet: WalletPlatform = Object.assign(Object.create(servicesPlatform!.wallet), {
    approvePayment: async () => ({ ...pending, state: "settled" }),
    cancelPayment: async () => ({ ...pending, state: "cancelled" }),
  });

  /** A bubble's Review payment button, which the review replaces once pressed. */
  function Bubble() {
    const [open, setOpen] = useState(false);
    return open ? <PaymentReview review={pending} wallet={wallet} onClose={() => setOpen(false)} /> : <button type="button" onClick={() => setOpen(true)}>Review payment</button>;
  }

  it("goes to the review it opened, then stays with it after Approve", async () => {
    const { user } = renderApp(<Bubble />);
    await user.tab();
    expect(screen.getByRole("button", { name: "Review payment" })).toHaveFocus();
    await user.keyboard("{Enter}");
    const title = screen.getByRole("heading", { name: /Review/ });
    expect(title).toHaveFocus();
    // On from the title: its details, then Approve.
    await user.tab();
    await user.tab();
    expect(screen.getByTestId("review-approve")).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByTestId("review-approve")).not.toBeInTheDocument());
    expect(screen.getByRole("heading")).toHaveFocus();
  });

  it("is never taken from where it is: after Cancel it stays on the button in its place", async () => {
    const { user } = renderApp(<Bubble />);
    await user.tab();
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });
});

// covers: payments.chat.refused, payments.chat.review
describe("a refused send whose ecash came back", () => {
  /**
   * A reviewed Cashu send the contact refused (a group request another member paid first): its ecash came back through a
   * swap at the mint, which kept a fee. The review says exactly what came back, not "The sats came back" as if all did,
   * and why some stayed with the mint is behind the ⓘ.
   */
  const wallet = servicesPlatform!.wallet;
  const refused = (patch: Partial<Review>): Review => ({
    method: "cashu", network: "cashu-test", provider: TEST_MINT, asset: "BTC", unit: "sat", address: "pay-1", expiresAt: Date.now() + 60_000,
    id: "review-1", payee: "peer", amount: 100, fee: 2, feeCap: 10, createdAt: 0, state: "failed", ...patch,
  } as Review);
  const show = (review: Review, language?: AppRenderOptions["language"]) => {
    fakeEngine.setState({ links: [linkView()], wallet: { intents: [review] } });
    return renderApp(<PaymentReview review={review} wallet={wallet} onClose={() => {}} />, language ? { language } : undefined);
  };

  it("says what came back and what the mint kept, with the why behind the ⓘ", async () => {
    const { user } = show(refused({ error: "Refused: Already paid by another member of the group. 98 sats came back; the mint kept 2 as its fee.", returned: { amount: 98, fee: 2 } }));
    expect(screen.getByTestId("review-error")).toHaveTextContent(/^The payment was refused(?:Already paid by another member of the group\. 98 sats came back; the mint kept 2\.)$/);
    expect(screen.queryByTestId("review-returned-text")).not.toBeInTheDocument();
    const info = screen.getByTestId("review-returned-info");
    expect(info).toHaveAttribute("aria-expanded", "false");
    await user.click(info);
    expect(info).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("review-returned-text")).toHaveTextContent("Taking ecash back is a swap at the mint, which keeps a small fee: 2 test sats this time.");
  });

  it("says it in the app's language", () => {
    show(refused({ error: "Refused: Already paid by another member of the group. 98 sats came back; the mint kept 2 as its fee.", returned: { amount: 98, fee: 2 } }), "pt");
    expect(screen.getByTestId("review-error")).toHaveTextContent("O pagamento foi recusado" + "Já foi pago por outro membro do grupo. 98 sats voltaram; o mint ficou com 2.");
  });

  it("has nothing behind an ⓘ when all of it came back, or when what came back is not known", () => {
    show(refused({ error: "Refused: Already paid by another member of the group. All 100 sats came back.", returned: { amount: 100, fee: 0 } }));
    expect(screen.getByTestId("review-error")).toHaveTextContent("All 100 sats came back.");
    expect(screen.queryByTestId("review-returned-info")).not.toBeInTheDocument();
  });
});

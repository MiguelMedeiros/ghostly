import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import { fakeEngine, linkView, paymentView } from "../fakeEngine";
import { renderApp } from "../render";
import { mint, reviewOf, TEST_MINT } from "./fixtures";

// covers: payments.chat.review, groups.payments.member

/**
 * A Cashu payment's review says whom it goes to. Its address is no place: paying a contact's request it was the
 * request's own id ("Destination ixRP7LArS6TzgrVr"), which names nobody. The chat's name for the contact goes there,
 * or in a group the name the member gave themselves.
 */
describe("the review of a Cashu payment from the chat", () => {
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

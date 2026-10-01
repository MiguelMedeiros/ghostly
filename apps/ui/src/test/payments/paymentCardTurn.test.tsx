import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PaymentComposer } from "../../components/PaymentComposer";
import { rememberRail } from "../../lib/chatPayments";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { everyWallet, reviewContext } from "./fixtures";

// covers: payments.chat.cards, payments.cashu.request

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

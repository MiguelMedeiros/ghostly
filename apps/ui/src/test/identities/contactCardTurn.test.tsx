import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { ContactIdentitiesPanel } from "../../components/identities/ContactIdentitiesPanel";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { identitiesView, receivedView } from "./views";

// covers: proofs.recheck

/**
 * A Check again click that landed while the contact's card was still turning over reached nothing: the full E2E run
 * 36781042523 clicked it 460 ms into the 520 ms turn, and the proof stayed "Verified" after its file was gone. Until the
 * turn is over the back's buttons wait (as the payment sheet's do, #776); then they take the first click. These tests
 * give the card a short turn of its own (the UI tests load no stylesheets; happy-dom does not expand the shorthand).
 */
const TURN_MS = 150;
let turn: HTMLStyleElement;
beforeEach(() => {
  turn = document.createElement("style");
  turn.textContent = `.deck-flip-card{transition-property:transform;transition-duration:${TURN_MS}ms}`;
  document.head.append(turn);
});
afterEach(() => { turn.remove(); delete document.documentElement.dataset.reduceMotion; });

function open() {
  const view = renderApp(<ContactIdentitiesPanel peerKey="peer" name="Alice" onClose={() => {}} />);
  const received = [receivedView({ id: "r1" })];
  act(() => view.engine.update({ links: [linkView({ pairing: { status: "ready" } as LinkView["pairing"], identities: identitiesView({ received }) })] }));
  view.engine.on("recheckIdentityProof", () => undefined);
  return view;
}

it("keeps Check again waiting while the contact's card turns over, then takes the first click", async () => {
  const { user, engine } = open();
  await user.click(within(screen.getByTestId("chat-identities-received")).getAllByTestId("chat-identity-received")[0]);
  const recheck = screen.getByTestId("chat-identity-recheck");
  // Mid-turn: not clickable, so a click waits instead of reaching a card still swinging round.
  expect(recheck).toBeDisabled();
  await waitFor(() => expect(recheck).toBeEnabled());
  await user.click(recheck);
  expect(engine.callsTo("recheckIdentityProof")).toEqual([{ linkId: "link-1", id: "r1" }]);
});

it("waits again when the card is turned back and over once more", async () => {
  const { user } = open();
  const cards = () => within(screen.getByTestId("chat-identities-received")).getAllByTestId("chat-identity-received");
  await user.click(cards()[0]);
  await waitFor(() => expect(screen.getByTestId("chat-identity-recheck")).toBeEnabled());
  await user.click(screen.getByTestId("chat-identity-cards"));
  await waitFor(() => expect(screen.queryByTestId("chat-identity-back")).not.toBeInTheDocument());
  await user.click(cards()[0]);
  expect(screen.getByTestId("chat-identity-recheck")).toBeDisabled();
  await waitFor(() => expect(screen.getByTestId("chat-identity-recheck")).toBeEnabled());
});

// With motion reduced there is no turn (the faces cross-fade where they are): nothing to wait for once it is flipped.
it("does not wait with motion reduced", async () => {
  document.documentElement.dataset.reduceMotion = "true";
  turn.textContent = `.deck-flip-card{transition-property:none;transition-duration:0s}`;
  const { user, engine } = open();
  await user.click(within(screen.getByTestId("chat-identities-received")).getAllByTestId("chat-identity-received")[0]);
  await waitFor(() => expect(screen.getByTestId("chat-identity-recheck").closest(".deck-flip")).toHaveAttribute("data-flipped", "true"));
  expect(screen.getByTestId("chat-identity-recheck")).toBeEnabled();
  await user.click(screen.getByTestId("chat-identity-recheck"));
  expect(engine.callsTo("recheckIdentityProof")).toHaveLength(1);
});

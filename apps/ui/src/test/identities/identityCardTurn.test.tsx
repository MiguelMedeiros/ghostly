import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { ComposerIdentityPicker } from "../../components/identities/ComposerIdentities";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { identitiesView, proofView, sharedView } from "./views";

// covers: proofs.composer, proofs.share, proofs.ghostly-card

/**
 * The identity picker's back turns over like the payment card's (deck/Flip.tsx), and a click that landed on Share or
 * Copy key while it was still turning could reach nothing. Until the turn is over its buttons wait, faded out; then
 * they take the first click, and the keys. These tests give the card its turn (the UI tests load no stylesheets), a
 * short one: the guard reads its length. In longhands: happy-dom does not expand the `transition` shorthand.
 */
const TURN_MS = 150;
let turn: HTMLStyleElement;
beforeEach(() => {
  turn = document.createElement("style");
  turn.textContent = `.deck-flip-card{transition-property:transform;transition-duration:${TURN_MS}ms}`;
  document.head.append(turn);
});
afterEach(() => turn.remove());

const KEY = "yzk3gq8qpjb1g4mzr3ff3kr1j4c1b7dxy8dd3mkwqc9k7p3e1mio";
/** A paired chat with Alice, connected now. */
const paired = (patch: Partial<LinkView> = {}) => linkView({ pairing: { status: "ready" } as LinkView["pairing"], myPubKeyZ32: KEY, identities: identitiesView(), ...patch });

function open(state: Parameters<ReturnType<typeof renderApp>["engine"]["update"]>[0], reduceMotion = false) {
  const result = renderApp(<ComposerIdentityPicker peerKey="peer" contact="Alice" onClose={vi.fn()} />);
  // After the render, which applies the profile's own setting as it mounts.
  if (reduceMotion) document.documentElement.dataset.reduceMotion = "true";
  act(() => result.engine.update(state));
  return result;
}

const ghostly = () => screen.getByTestId("composer-identity-ghostly");
const share = () => screen.getByTestId("composer-identity-share");
const copyKey = () => screen.getByTestId("composer-identity-copy-key");
const actions = (button: HTMLElement) => button.closest(".id-card-back-actions");

it("keeps Share waiting while an identity's card turns, then takes the first click and the keys", async () => {
  const { user, engine } = open({ links: [paired()], identityProofs: [proofView({ id: "a" })] });
  engine.on("shareIdentityProof", () => new Promise<void>(() => {}));
  await user.click(screen.getByTestId("composer-identity"));
  // Mid-turn: out of sight and not clickable, a click is not lost to a card still swinging round.
  expect(share()).toBeDisabled();
  expect(actions(share())).toHaveAttribute("data-turning", "true");
  await waitFor(() => expect(share()).toBeEnabled());
  expect(actions(share())).not.toHaveAttribute("data-turning");
  // The keys go to the action once it can take them.
  expect(share()).toHaveFocus();
  await user.click(share());
  expect(engine.callsTo("shareIdentityProof")).toEqual([{ linkId: "link-1", id: "a" }]);
});

it("keeps the Ghostly card's Share only this and Copy key waiting while it turns", async () => {
  const { user, engine } = open({
    links: [paired({ identities: identitiesView({ shared: [sharedView({ id: "a", status: "accepted" })] }) })],
    identityProofs: [proofView({ id: "a" })],
  });
  engine.on("withdrawIdentityProof", () => undefined);
  await user.click(ghostly());
  expect(share()).toBeDisabled();
  expect(copyKey()).toBeDisabled();
  expect(actions(copyKey())).toHaveAttribute("data-turning", "true");
  await waitFor(() => expect(copyKey()).toBeEnabled());
  expect(share()).toBeEnabled();
  expect(share()).toHaveFocus();
  await user.click(copyKey());
  expect(await navigator.clipboard.readText()).toBe(KEY);
  await user.click(share());
  expect(engine.callsTo("withdrawIdentityProof")).toEqual([{ linkId: "link-1", id: "a" }]);
});

it("waits again when the card is turned back and over once more", async () => {
  const { user } = open({ links: [paired()], identityProofs: [proofView({ id: "a" })] });
  await user.click(ghostly());
  await waitFor(() => expect(copyKey()).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Choose another identity" }));
  await user.click(await screen.findByTestId("composer-identity-ghostly"));
  expect(copyKey()).toBeDisabled();
  await waitFor(() => expect(copyKey()).toBeEnabled());
});

// With motion reduced there is no turn (flip.css takes the card's transition away, the faces cross-fade where they
// are): nothing to wait for.
it("does not wait with motion reduced", async () => {
  turn.textContent = `.deck-flip-card{transition-property:none;transition-duration:0s}`;
  const { user } = open({ links: [paired()], identityProofs: [proofView({ id: "a" })] }, true);
  await user.click(ghostly());
  expect(copyKey()).toBeEnabled();
  expect(actions(copyKey())).not.toHaveAttribute("data-turning");
});

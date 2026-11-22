import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { ComposerIdentityPicker } from "../../components/identities/ComposerIdentities";
import { ContactIdentitiesPanel } from "../../components/identities/ContactIdentitiesPanel";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { identitiesView, proofView, receivedView } from "./views";

// covers: proofs.deck, proofs.composer, app.i18n

/*
 * An ID card's name is the account's own words, in whatever script it wrote them, and its short identity is a key or a
 * fingerprint read left to right. In Arabic the card's face showed "alice!" as "!alice" and "@alice" as "alice@", its
 * back "OpenPGP · alice!" as "!OpenPGP · alice" and an OpenPGP fingerprint's end "…ABCD EF01" as "ABCD EF01…", as if it
 * were its start (the face already kept the short identity left to right). Each keeps its own direction now: the name
 * in a <bdi>, the short identity in a <bdi dir="ltr">, on the face and on the back.
 */

const FINGERPRINT = "0123456789ABCDEF0123456789ABCDEF01234567";
const NAME = "alice!";
const SHORT = "…89AB CDEF 0123 4567";
const display = { name: NAME, source: "OpenPGP key user ID (self-described)", fetchedAt: Math.floor(Date.now() / 1000) };
const paired = (patch: Partial<LinkView> = {}) => linkView({ pairing: { status: "ready" } as LinkView["pairing"], identities: identitiesView(), ...patch });

/** Every element showing exactly this text is a <bdi> (with `dir`, when given). */
const isolated = (root: HTMLElement, text: string, dir?: string) => {
  const shown = within(root).queryAllByText(text);
  return shown.length > 0 && shown.every(e => e.tagName === "BDI" && (dir === undefined || e.getAttribute("dir") === dir));
};

describe("in Arabic, an ID card's name and short identity keep their own direction", () => {
  it("a contact's card: on its face and on its back", async () => {
    const { user, engine } = renderApp(<ContactIdentitiesPanel peerKey="peer" name="Alice" onClose={vi.fn()} />, { language: "ar" });
    document.documentElement.dataset.reduceMotion = "true";
    const received = receivedView({ provider: "openpgp", subject: FINGERPRINT, verified: { subject: FINGERPRINT, source: "OpenPGP signature", display } });
    act(() => engine.update({ links: [paired({ identities: identitiesView({ received: [received] }) })] }));
    const card = within(screen.getByTestId("chat-identities-received")).getAllByTestId("chat-identity-received")[0]!;
    expect(isolated(card, NAME), "face: name").toBe(true);
    expect(isolated(card, SHORT, "ltr"), "face: short identity").toBe(true);
    await user.click(card);
    const back = screen.getByTestId("chat-identity-back");
    expect(isolated(back, NAME), "back: name").toBe(true);
    expect(isolated(back, SHORT, "ltr"), "back: short identity").toBe(true);
  });

  it("one of mine in the composer's picker: on its face and on its back", async () => {
    const { user, engine } = renderApp(<ComposerIdentityPicker peerKey="peer" contact="Alice" onClose={vi.fn()} />, { language: "ar" });
    document.documentElement.dataset.reduceMotion = "true";
    act(() => engine.update({ links: [paired()], identityProofs: [proofView({ provider: "openpgp", subject: FINGERPRINT, verified: { subject: FINGERPRINT, source: "OpenPGP signature", display } })] }));
    const card = screen.getAllByTestId("composer-identity")[0]!;
    expect(isolated(card, NAME), "face: name").toBe(true);
    await user.click(card);
    await waitFor(() => expect(screen.getByTestId("composer-identity-back")).toBeInTheDocument());
    const back = screen.getByTestId("composer-identity-back");
    expect(isolated(back, NAME), "back: name").toBe(true);
    expect(isolated(back, SHORT, "ltr"), "back: short identity").toBe(true);
  });
});

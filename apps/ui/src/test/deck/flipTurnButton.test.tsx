import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ForwardArrow } from "../../components/ComposerSheet";
import { FlipTurnButton } from "../../components/deck/Flip";
import type { Language } from "../../lib/settings";
import { translatorFor } from "../../locales";
import { renderApp } from "../render";

// covers: wallet.deck, proofs.deck

/**
 * A turned card's way back to the deck shows "‹ Cards" and says in full where it goes. Its name holds the word it
 * shows (WCAG 2.5.3 Label in Name: a voice control user says "click Cards"), and the full text is its description,
 * for every deck that turns a card (the identity picker, a contact's identities, the payment sheet) in every language.
 */
const LANGUAGES: Language[] = ["en", "pt", "es", "fr", "it", "zh", "ja", "ar"];
const LABELS = [
  (t: ReturnType<typeof translatorFor>) => t("identities.picker.chooseAnother"),
  (t: ReturnType<typeof translatorFor>) => t("identities.contact.backToCards", { name: "Alice" }),
  (t: ReturnType<typeof translatorFor>) => t("payments.composer.backToCards"),
];

describe("A turned card's back button", () => {
  for (const language of LANGUAGES) {
    it(`is named by the word it shows, the full text its description (${language})`, () => {
      const t = translatorFor(language);
      for (const label of LABELS) {
        const { unmount } = renderApp(<FlipTurnButton testId="turn" label={label(t)} onClick={() => {}} />, { language });
        const button = screen.getByTestId("turn");
        const shown = button.textContent!.trim();
        expect(shown).toBe(t("common.deck.turnBack"));
        expect(button).toHaveAccessibleName(expect.stringContaining(shown));
        expect(button).toHaveAccessibleDescription(label(t));
        unmount();
      }
    });
  }

  // A right-to-left language puts it at the card's right: a chevron still pointing left pointed on, into the card.
  it("its chevron is mirrored in a right-to-left language, so it points back", () => {
    renderApp(<FlipTurnButton testId="turn" label="Back to the cards" onClick={() => {}} />, { language: "ar" });
    expect(screen.getByTestId("turn").querySelector("svg")).toHaveClass("rtl:-scale-x-100");
  });
});

describe("A sheet action's arrow", () => {
  // It follows the action's words: in a right-to-left language it sits at their left, and pointing right it pointed
  // back at them instead of on.
  it("is mirrored in a right-to-left language, so it points on", () => {
    renderApp(<button type="button" data-testid="go">Go<ForwardArrow /></button>, { language: "ar" });
    expect(screen.getByTestId("go").querySelector("svg")).toHaveClass("rtl:-scale-x-100");
  });
});

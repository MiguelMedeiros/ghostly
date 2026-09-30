import type { Translate } from "../../contexts/I18nContext";

/** A deck's Previous and Next arrows, named in the app's language (deck/Deck.tsx stays free of the app's i18n: the website copies it). */
export const deckArrows = (t: Translate) => ({ previous: t("common.deck.previous"), next: t("common.deck.next") });

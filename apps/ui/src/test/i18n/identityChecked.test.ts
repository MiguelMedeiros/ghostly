import { describe, expect, it } from "vitest";
import { receivedIdCard } from "../../components/identities/idCard";
import { translateWith } from "../../locales/translate";
import { now, receivedView } from "../identities/views";
import { LANGUAGES, LOCALES, lookup } from "./locales";

// covers: app.i18n

/**
 * When a contact's identity was last checked is not whether it held: a card whose check failed, or that was
 * revoked or withdrawn, says when it was checked, never in its language's word for "verified".
 */

const verifiedWords = (language: (typeof LANGUAGES)[number]) =>
  ["identities.card.verified", "identities.status.verified"]
    .map(key => lookup(language, key)?.toLocaleLowerCase(language))
    .filter((word): word is string => !!word);

describe.each(LANGUAGES)("in %s", (language) => {
  const t = translateWith(LOCALES[language], language);

  it.each(["unconfirmed", "revoked", "withdrawn"] as const)("a %s card's checked line does not say verified", (status) => {
    const card = receivedIdCard(receivedView({ status, checkedAt: now() }), now(), t, language);
    expect(card.status).not.toBe("verified");
    for (const word of verifiedWords(language)) expect(card.shared.toLocaleLowerCase(language)).not.toContain(word);
  });

  it("the back's and the overview's checked labels do not say verified", () => {
    for (const key of ["identities.contact.checked", "identities.received.checked"]) {
      const text = lookup(language, key)!.toLocaleLowerCase(language);
      for (const word of verifiedWords(language)) expect(text, key).not.toContain(word);
    }
  });
});

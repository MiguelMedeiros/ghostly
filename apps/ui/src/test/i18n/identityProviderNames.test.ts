import { describe, expect, it } from "vitest";
import { contactBadges, marksText } from "../../components/identities/contactBadges";
import { idCard, receivedIdCard, shareIdCard } from "../../components/identities/idCard";
import { providerLabel } from "../../lib/identities";
import { translateWith } from "../../locales/translate";
import { proofView, receivedView } from "../identities/views";
import { LOCALES, lookup } from "./locales";

// covers: app.i18n

/**
 * A built-in provider's name on a card, a mark and its card is the one the Add picker shows, in the app's language
 * ("Domínio", "نطاق"), not the provider's English; and a mark's words are joined the way that language joins them.
 */

describe.each(["pt", "ar"] as const)("in %s", (language) => {
  const t = translateWith(LOCALES[language], language);
  const name = (provider: string) => lookup(language, `identities.providers.${provider}.label`)!;

  it("a provider's name is the language's", () => {
    expect(name("domain")).not.toBe("Domain");
    expect(providerLabel("domain", t)).toBe(name("domain"));
    expect(providerLabel("ssh-github", t)).toBe(name("ssh-github"));
  });

  it("an ID card, mine, a contact's or a share's, names its provider in the language", () => {
    expect(idCard(proofView(), { t }).label).toBe(name("domain"));
    expect(receivedIdCard(receivedView(), undefined, t, language).label).toBe(name("domain"));
    expect(shareIdCard({ proof: "gone", provider: "ssh-github", subject: "octocat", at: 0 } as never, "unanswered", { t }).label).toBe(name("ssh-github"));
  });

  it("a mark names its provider in the language, and its words and the marks are joined the language's way", () => {
    const badges = contactBadges([receivedView(), receivedView({ id: "received-2", provider: "ssh-github", subject: "octocat", verified: { subject: "octocat", source: "github.com" } })], { t, language });
    expect(badges.map(b => b.providerName)).toEqual([name("domain"), name("ssh-github")]);
    expect(badges[0]!.label).toBe(t("identities.badge.mark", { provider: name("domain"), subject: "example.org", state: badges[0]!.stateText }));
    expect(marksText(badges, t)).toBe(t("identities.badge.markList", { list: badges[0]!.label, next: badges[1]!.label }));
    expect(marksText(badges, t)).not.toContain("Domain");
    if (language === "ar") expect(marksText(badges, t)).toContain("؛");
  });
});

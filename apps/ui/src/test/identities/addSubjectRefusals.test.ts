import { beforeAll, describe, expect, it } from "vitest";
import { loadIdentityProviders } from "@ghostly/browser/proofs/load";
import { IDENTITY_PROVIDERS } from "@ghostly/browser/proofs/registry";
import { problemText } from "../../lib/problemText";
import { localProvider } from "../../lib/providerWords";
import { translatorFor } from "../../locales";
import { LANGUAGES } from "../i18n/locales";

// covers: proofs.picker, proofs.bitcoin, proofs.pubky, app.i18n

/**
 * What Add's field refuses, for every built-in provider, as the dialog says it: in the app's language, never the
 * provider's English as the title. A Bitcoin address and a Pubky key the field refused were said in English in every
 * language ("Not a Bitcoin address", "That is not a Pubky key: 52 characters, …").
 */
const BAD = ["x", "hello world", "bitcoin:", "https://example.com/a/b", "at://alice.bsky.social", "0x1234ABCD", "@"];
// OpenID Connect's field is a picker that starts on a provider: its "Choose a provider" is never typed into.
const TYPED = IDENTITY_PROVIDERS.filter((p) => p.id !== "oidc");

const refusals = (language: (typeof LANGUAGES)[number]) => {
  const t = translatorFor(language);
  return TYPED.flatMap((raw) => BAD.flatMap((input) => {
    try { localProvider(raw, t).subject.normalize(input); return []; } catch (e) { return [{ id: raw.id, input, said: problemText(e, t) }]; }
  }));
};

describe("what Add's field refuses, in every language", () => {
  beforeAll(() => loadIdentityProviders());

  it("each provider refuses something here", () => {
    expect(new Set(refusals("en").map((r) => r.id))).toEqual(new Set(TYPED.map((p) => p.id)));
  });

  it.each(LANGUAGES.filter((l) => l !== "en"))("in %s, no refusal is the provider's English", (language) => {
    const english = refusals("en");
    const same = refusals(language).filter((r, i) => JSON.stringify(r.said) === JSON.stringify(english[i]!.said));
    expect(same.map((r) => `${r.id} ${JSON.stringify(r.input)}: ${r.said.title}`)).toEqual([]);
  });

  it("an address with a typo and a key of the wrong length say what to do next", () => {
    const pt = translatorFor("pt");
    const said = (id: string, input: string) => {
      try { localProvider(TYPED.find((p) => p.id === id)!, pt).subject.normalize(input); } catch (e) { return problemText(e, pt); }
      throw new Error(`${id} took ${input}`);
    };
    expect(said("bitcoin", "x")).toEqual({ tone: "error", title: pt("errors.proof.btcNotAddress"), next: pt("errors.proof.btcNotAddressNext") });
    expect(said("bitcoin", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3")).toEqual({ tone: "error", title: pt("errors.proof.btcNotAddress"), next: pt("errors.proof.btcNotAddressNext") });
    expect(said("pubky", "x")).toEqual({ tone: "error", title: pt("errors.proof.pubkyNotKey"), next: pt("errors.proof.pubkyNotKeyNext") });
  });
});

import { englishSay, type IdentityProofProvider, type IdentitySigner, type ProviderSay, type SignerField } from "@ghostly/browser/proofs/contract";
import { displaySourceOf } from "@ghostly/browser/proofs/displaySource";
import { builtInIdentityProvider } from "@ghostly/browser/proofs/load";
import type { Translate, TranslationKey } from "../locales/translate";

/*
 * A provider's words in the app's language (proofs/contract.ts `ProviderSay`). A built-in provider's lines are read
 * under `identities.providers.<provider id>.<path>`, each falling back to the provider's own English while its language
 * has none; a plugin's provider keeps its own words.
 */

/** How `provider` says its lines in `t`'s language: its English for a plugin, or for a line not translated yet. */
export function providerSay(provider: IdentityProofProvider, t: Translate): ProviderSay {
  if (!builtInIdentityProvider(provider)) return englishSay;
  return (key, english, values) => {
    const path = `identities.providers.${provider.id}.${key}`;
    const said = t(path as TranslationKey, values as Record<string, string | number> | undefined);
    return said === path ? englishSay(key, english, values) : said;
  };
}

/**
 * A proof's source in `t`'s language where the provider's words are fixed (`displaySourceOf`): who wrote a name (a
 * key's user ID is its holder's own, a sign-in provider may not have checked the email), or how a Nostr proof was
 * checked. Any other source is shown as written.
 */
export function sourceWords(provider: string, source: string, t: Translate): string {
  const known = displaySourceOf(provider, source);
  if (!known) return source;
  if (known.kind === "nostr-signature") return t("identities.contact.sourceNostrSignature");
  if (known.kind === "openpgp-user-id") return t("identities.contact.sourceUserId");
  if (known.kind === "openpgp-keyserver") return t("identities.contact.sourceKeyserver");
  const signer = { provider: known.provider };
  return known.email === "verified" ? t("identities.contact.sourceSignedEmailVerified", signer)
    : known.email === "unverified" ? t("identities.contact.sourceSignedEmailUnverified", signer)
    : t("identities.contact.sourceSigned", signer);
}

const cache = new WeakMap<Translate, WeakMap<IdentityProofProvider, IdentityProofProvider>>();

/**
 * `provider` as the app shows it in `t`'s language: its fixed words read by their path, and `say` handed to the
 * signers, the steps and the preview. The same object for the same provider and language, so it can be a hook's
 * dependency; the provider itself when it is a plugin's.
 */
export function localProvider<E>(provider: IdentityProofProvider<E>, t: Translate): IdentityProofProvider<E> {
  const p = provider as IdentityProofProvider;
  if (!builtInIdentityProvider(p)) return provider;
  let forT = cache.get(t);
  if (!forT) cache.set(t, forT = new WeakMap());
  let local = forT.get(p);
  if (!local) forT.set(p, local = translated(p, providerSay(p, t)));
  return local as IdentityProofProvider<E>;
}

function translated(p: IdentityProofProvider, say: ProviderSay): IdentityProofProvider {
  const word = <V extends string | undefined>(path: string, english: V): V => (english === undefined ? english : say(path, english) as V);
  const { subject, unpublish } = p;
  const preview = subject.preview;
  return {
    ...p,
    label: word("label", p.label),
    summary: word("summary", p.summary),
    description: word("description", p.description),
    limits: word("limits", p.limits),
    privacy: word("privacy", p.privacy),
    lookupLabel: word("lookupLabel", p.lookupLabel),
    subject: {
      ...subject,
      label: word("subject.label", subject.label),
      placeholder: word("subject.placeholder", subject.placeholder),
      help: word("subject.help", subject.help),
      // Read from the provider's own spec each time: OpenID Connect's issuers are a getter, the ones configured now.
      get options() { return subject.options; },
      normalize: input => subject.normalize(input),
      ...(subject.short && { short: (s: string) => subject.short!(s) }),
      ...(preview && { preview: (s: string, options: { signal: AbortSignal; say?: ProviderSay }) => preview.call(subject, s, { ...options, say: options.say ?? say }) }),
    },
    ...(unpublish && {
      unpublish: { description: word("unpublish.description", unpublish.description), run: (proof, ctx) => unpublish.run(proof, { ...ctx, say: ctx.say ?? say }) },
    }),
    signers: p.signers.map(s => signerIn(s, say, word)),
  };
}

function signerIn(s: IdentitySigner<unknown>, say: ProviderSay, word: <V extends string | undefined>(path: string, english: V) => V): IdentitySigner<unknown> {
  const at = `signers.${s.id}`;
  const base = { label: word(`${at}.label`, s.label), description: word(`${at}.description`, s.description), action: word(`${at}.action`, s.action) };
  switch (s.kind) {
    case "in-app": {
      const fields = s.fields?.map((f): SignerField => ({
        ...f, label: word(`${at}.fields.${f.name}.label`, f.label), placeholder: word(`${at}.fields.${f.name}.placeholder`, f.placeholder), help: word(`${at}.fields.${f.name}.help`, f.help),
      }));
      return { ...s, ...base, ...(fields && { fields }), run: (ctx, work) => s.run({ ...ctx, say: ctx.say ?? say }, work) };
    }
    case "redirect": return { ...s, ...base, start: (statement, ctx) => s.start(statement, { ...ctx, say: ctx.say ?? say }) };
    case "external-tool": return { ...s, ...base, instructions: (statement, given) => s.instructions(statement, given ?? say) };
    case "publish": return { ...s, ...base, instructions: (statement, given) => s.instructions(statement, given ?? say) };
  }
}

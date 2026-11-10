import { afterEach, describe, expect, it, vi } from "vitest";
import { newIdentityBinding, identityStatement } from "@ghostly/core";
import type { ExternalToolSigner, IdentityProofProvider } from "@ghostly/browser/proofs/contract";
import { OIDC_PROVIDERS } from "@ghostly/browser/proofs/oidc/providers";
import { builtInIdentityProvider } from "@ghostly/browser/proofs/load";
import { IDENTITY_PROVIDERS } from "@ghostly/browser/proofs/registry";
import { localProvider, providerSay } from "../../lib/providerWords";
import { translateWith } from "../../locales/translate";
import { LOCALES, lookup } from "../i18n/locales";

const provider = (id: string) => IDENTITY_PROVIDERS.find((p) => p.id === id)!;

/** A language whose dictionary has some of the SSH key provider's lines, and none of the others'. */
const t = translateWith({
  identities: {
    providers: {
      ssh: {
        label: "Clé SSH",
        summary: "Signez une fois avec ssh-keygen",
        subject: { help: "Votre clé publique, la ligne du fichier .pub." },
        signers: { "ssh-keygen": { description: "Signez avec ssh-keygen d'OpenSSH." } },
        steps: { paste: "Collez la signature de {{name}}." },
      },
    },
  },
}, "fr");

/** A provider's fixed words, by the path `localProvider` reads each under. */
function fixedWords(p: IdentityProofProvider): [string, string][] {
  const out: [string, string | undefined][] = [
    ["label", p.label], ["summary", p.summary], ["description", p.description], ["limits", p.limits], ["privacy", p.privacy], ["lookupLabel", p.lookupLabel],
    ["subject.label", p.subject.label], ["subject.placeholder", p.subject.placeholder], ["subject.help", p.subject.help],
    ["unpublish.description", p.unpublish?.description],
  ];
  for (const s of p.signers) {
    out.push([`signers.${s.id}.label`, s.label], [`signers.${s.id}.description`, s.description], [`signers.${s.id}.action`, s.action]);
    if (s.kind === "in-app") for (const f of s.fields ?? []) {
      out.push([`signers.${s.id}.fields.${f.name}.label`, f.label], [`signers.${s.id}.fields.${f.name}.placeholder`, f.placeholder], [`signers.${s.id}.fields.${f.name}.help`, f.help]);
    }
  }
  return out.filter((w): w is [string, string] => w[1] !== undefined);
}

/** Fixed words that are a name or an example, the same in every language: they have no string. */
const SAID_AS_IS = new Set([
  "nostr.label", "nostr.subject.placeholder", "nostr.signers.nip46.fields.bunker.placeholder",
  "pubky.label", "pubky.subject.placeholder",
  "domain.subject.placeholder", "domain.signers.nip05-nip07.fields.domain.placeholder", "domain.signers.nip05-nip46.fields.domain.placeholder",
  "domain.signers.nip05-nip46.fields.bunker.placeholder",
  "openpgp.signers.gpg.label",
  "bitcoin.signers.sparrow.label", "bitcoin.signers.bitcoin-core.label", "bitcoin.signers.electrum.label", "bitcoin.signers.coldcard.label", "bitcoin.signers.trezor.label",
  "ssh.signers.ssh-keygen.label", "ssh-github.signers.ssh-keygen.label", "ssh-gitlab.signers.ssh-keygen.label", "ssh-github.subject.placeholder",
  "did.label", "did.subject.label",
  "atproto.label", "atproto.subject.placeholder", "atproto.signers.atproto-oauth.fields.handle.placeholder", "atproto.signers.atproto-oauth-full.fields.handle.placeholder",
].map(path => `identities.providers.${path}`));

/** A provider a plugin registered: not built in, so its words are its own. */
const plugin: IdentityProofProvider = { ...provider("ssh"), id: "acme", label: "Acme key", summary: "Sign with Acme" };

describe("a provider's words in the app's language", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("reads a built-in provider's fixed words under identities.providers.<id>, English where the language has none", () => {
    const ssh = localProvider(provider("ssh"), t);
    expect(ssh.label).toBe("Clé SSH");
    expect(ssh.summary).toBe("Signez une fois avec ssh-keygen");
    expect(ssh.subject.help).toBe("Votre clé publique, la ligne du fichier .pub.");
    expect(ssh.signers[0]!.description).toBe("Signez avec ssh-keygen d'OpenSSH.");
    // Not translated yet: the provider's own English.
    expect(ssh.description).toBe(provider("ssh").description);
    expect(ssh.privacy).toBe(provider("ssh").privacy);
    expect(ssh.subject.label).toBe(provider("ssh").subject.label);
    expect(ssh.signers[0]!.label).toBe("ssh-keygen");
    // What it does is the provider's: only its words change.
    expect(ssh.id).toBe("ssh");
    expect(ssh.subject.normalize(`SHA256:${"A".repeat(43)}`)).toBe(`SHA256:${"A".repeat(43)}`);
    expect(ssh.verify).toBe(provider("ssh").verify);
  });

  it("says a line worked out at run time in the language, its values filled in, and English when it has none", () => {
    const say = providerSay(provider("ssh"), t);
    expect(say("steps.paste", "Paste {{name}}'s signature.", { name: "ssh-keygen" })).toBe("Collez la signature de ssh-keygen.");
    expect(say("steps.other", "Run {{tool}} once.", { tool: "ssh-keygen" })).toBe("Run ssh-keygen once.");
    // Another provider's key of the same name is not this one's.
    expect(providerSay(provider("openpgp"), t)("steps.paste", "Paste it.")).toBe("Paste it.");
  });

  it("hands the language to the steps of a signer the person runs", () => {
    const signer = provider("ssh").signers[0] as ExternalToolSigner<unknown>;
    const instructions = vi.spyOn(signer, "instructions");
    const statement = identityStatement(newIdentityBinding({ provider: "ssh", subject: `SHA256:${"A".repeat(43)}`, validitySeconds: 86400 }).binding);
    (localProvider(provider("ssh"), t).signers[0] as ExternalToolSigner<unknown>).instructions(statement);
    const say = instructions.mock.calls[0]![1]!;
    expect(say("steps.paste", "Paste {{name}}'s signature.", { name: "gpg" })).toBe("Collez la signature de gpg.");
  });

  it("leaves a plugin's provider as it is, in its own words", () => {
    expect(localProvider(plugin, t)).toBe(plugin);
    expect(providerSay(plugin, t)("label", "Acme key")).toBe("Acme key");
    expect(providerSay(plugin, t)("steps.paste", "Paste {{name}}'s signature.", { name: "acme" })).toBe("Paste acme's signature.");
  });

  it("is the same object for the same provider and language, so a hook may depend on it", () => {
    expect(localProvider(provider("ssh"), t)).toBe(localProvider(provider("ssh"), t));
    expect(localProvider(provider("ssh"), translateWith({}, "en"))).not.toBe(localProvider(provider("ssh"), t));
  });

  describe("a built-in provider's fixed words", () => {
    const words = IDENTITY_PROVIDERS.filter(builtInIdentityProvider).flatMap(p => fixedWords(p).map(([path, english]) => ({ key: `identities.providers.${p.id}.${path}`, english })));

    it("finds every provider's words", () => {
      expect(new Set(words.map(w => w.key.split(".")[2]))).toEqual(new Set(["nostr", "pubky", "domain", "openpgp", "bitcoin", "ssh", "ssh-github", "ssh-gitlab", "oidc", "did", "atproto"]));
      expect(words.length).toBeGreaterThan(130);
    });

    it("each have a string, names and examples aside", () => {
      expect(words.filter(w => lookup("en", w.key) === undefined && !SAID_AS_IS.has(w.key)).map(w => w.key)).toEqual([]);
      expect([...SAID_AS_IS].filter(key => !words.some(w => w.key === key))).toEqual([]);
    });

    it("are in English what the provider itself says", () => {
      // Edit a provider's words and not its string here, and the English shown would drift from the provider's own.
      expect(words.filter(w => lookup("en", w.key) !== undefined && lookup("en", w.key) !== w.english).map(w => w.key)).toEqual([]);
    });

    it("are said in Arabic on the chooser, the form and the start button", () => {
      const ar = translateWith(LOCALES.ar, "ar");
      const github = localProvider(provider("ssh-github"), ar);
      expect(github.label).not.toBe(provider("ssh-github").label);
      expect(github.subject.label).not.toBe("GitHub username");
      const atproto = localProvider(provider("atproto"), ar).signers.find(s => s.id === "atproto-oauth")!;
      expect(atproto.action).not.toBe("Continue on your server");
      expect(localProvider(provider("nostr"), ar).signers.find(s => s.id === "nip46")).toMatchObject({ fields: [expect.objectContaining({ label: lookup("ar", "identities.providers.nostr.signers.nip46.fields.bunker.label") })] });
      // A name is the same in every language.
      expect(localProvider(provider("openpgp"), ar).signers[0]!.label).toBe("gpg");
    });
  });

  it("lists OpenID Connect's issuers as configured now, not as they were when first shown", () => {
    const oidc = localProvider(provider("oidc"), t);
    const before = oidc.subject.options?.length ?? 0;
    const saved = OIDC_PROVIDERS.google.clientIds;
    OIDC_PROVIDERS.google.clientIds = { web: "google-client" };
    try {
      expect(oidc.subject.options?.length).toBe(provider("oidc").subject.options?.length);
      expect(provider("oidc").subject.options?.length).toBeGreaterThan(before);
    } finally { OIDC_PROVIDERS.google.clientIds = saved; }
  });
});

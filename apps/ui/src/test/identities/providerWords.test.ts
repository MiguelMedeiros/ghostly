import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newIdentityBinding, identityStatement } from "@ghostly/core";
import { BITCOIN_WALLET_GUIDES } from "@ghostly/browser/proofs/bitcoinWallets";
import type { ExternalToolSigner, IdentityProofProvider, PublishSigner } from "@ghostly/browser/proofs/contract";
import { OIDC_PROVIDERS } from "@ghostly/browser/proofs/oidc/providers";
import { IDENTITY_PROVIDERS } from "@ghostly/browser/proofs/registry";
import { localProvider, providerSay } from "../../lib/providerWords";
import { translateWith } from "../../locales/translate";
import { LOCALES, lookup } from "../i18n/locales";

const provider = (id: string) => IDENTITY_PROVIDERS.find((p) => p.id === id)!;
/** An Ed25519 did:key (the all-zero seed's, from the did:key spec's test vectors): resolved on the device. */
const DID_KEY = "did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp";

const PROOFS = join(fileURLToPath(import.meta.url), "../../../../../../packages/browser/src/proofs");
/** The source files whose `say(key, english)` lines each built-in provider says. */
const SAYERS: Record<string, readonly string[]> = {
  "providers/ssh.ts": ["ssh", "ssh-github", "ssh-gitlab"],
  "providers/domain.ts": ["domain"], "providers/nostr.ts": ["nostr"], "providers/bitcoin.ts": ["bitcoin"], "providers/openpgp.ts": ["openpgp"],
  "providers/oidc.ts": ["oidc"], "providers/did.ts": ["did"], "providers/atproto.ts": ["atproto"], "atproto/oauth.ts": ["atproto"],
  "providers/pubky.ts": ["pubky"], "pubky.ts": ["pubky"],
};

/** Every `say("key", "english"…)` with a literal key, per provider that says it. */
function sayCalls(): { id: string; key: string; english: string }[] {
  return Object.entries(SAYERS).flatMap(([file, ids]) =>
    [...readFileSync(join(PROOFS, file), "utf8").matchAll(/(?:\bsay|englishSay\))\("([\w.-]+)",\s*("(?:[^"\\]|\\.)*")/g)]
      .flatMap(([, key, english]) => ids.map((id) => ({ id, key: key!, english: JSON.parse(english!) as string }))));
}

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

  it("says a built-in provider's steps, preview and progress in Portuguese with the app in pt", async () => {
    const pt = translateWith(LOCALES.pt, "pt");
    const domain = localProvider(provider("domain"), pt);
    const statement = identityStatement(newIdentityBinding({ provider: "domain", subject: "example.com", validitySeconds: 86400 }).binding);
    const steps = (domain.signers[0] as PublishSigner<unknown>).instructions(statement).steps;
    expect(steps[0]!.text).toBe(lookup("pt", "identities.providers.domain.dns.name")!.replace(/\{\{domain\}\}/g, "example.com"));
    expect(steps[0]!.text).toContain("example.com");
    expect(steps[1]!.text).toBe(lookup("pt", "identities.providers.domain.dns.value"));
    const preview = await localProvider(provider("did"), pt).subject.preview!(DID_KEY, { signal: new AbortController().signal });
    expect(preview.facts[0]!.label).toBe("Método");
    expect(providerSay(provider("pubky"), pt)("progress.writing", "Writing the proof to your homeserver…")).toBe(lookup("pt", "identities.providers.pubky.progress.writing"));
  });

  it("says a line in English when the app's language has no words for it", () => {
    const pt = structuredClone(LOCALES.pt) as unknown as { identities: { providers: { domain: { dns: Record<string, string> } } } };
    delete pt.identities.providers.domain.dns.value;
    const domain = localProvider(provider("domain"), translateWith(pt, "pt"));
    const statement = identityStatement(newIdentityBinding({ provider: "domain", subject: "example.com", validitySeconds: 86400 }).binding);
    const steps = (domain.signers[0] as PublishSigner<unknown>).instructions(statement).steps;
    expect(steps[1]!.text).toBe("Value (one string, exactly as shown):");
    expect(steps[0]!.text).not.toContain("Open the DNS settings");
  });

  /**
   * The English a provider passes to `say` is what a language without the line shows, and en/identities.json is what
   * translators work from: the two must not drift. Read from the sources, so a line on a path no test walks counts too.
   */
  it("has every line a built-in provider says in English, word for word, under identities.providers.<id>", () => {
    const said = sayCalls();
    expect(said.length).toBeGreaterThan(60);
    const drift = said.filter(({ id, key, english }) => lookup("en", `identities.providers.${id}.${key}`) !== english)
      .map(({ id, key }) => `${id}.${key}`);
    expect(drift).toEqual([]);
    // The wallets' own steps, said under wallets.<id>.
    const wallets = BITCOIN_WALLET_GUIDES.flatMap((g) => [
      ...g.steps.map((text, i) => [`wallets.${g.id}.step${i + 1}`, text]),
      ...(g.testnet ? [[`wallets.${g.id}.testnet`, g.testnet]] : []),
      ...(g.note ? [[`wallets.${g.id}.note`, g.note]] : []),
    ]);
    expect(wallets.filter(([key, text]) => lookup("en", `identities.providers.bitcoin.${key}`) !== text).map(([key]) => key)).toEqual([]);
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

import { afterEach, describe, expect, it, vi } from "vitest";
import { newIdentityBinding, identityStatement } from "@ghostly/core";
import type { ExternalToolSigner, IdentityProofProvider } from "@ghostly/browser/proofs/contract";
import { OIDC_PROVIDERS } from "@ghostly/browser/proofs/oidc/providers";
import { IDENTITY_PROVIDERS } from "@ghostly/browser/proofs/registry";
import { localProvider, providerSay } from "../../lib/providerWords";
import { translateWith } from "../../locales/translate";

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

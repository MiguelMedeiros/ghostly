import { dnsProofName, domainTxtRecord, domainWellKnownFile, normalizeDomain, wellKnownUrl, type DomainRecord, type IdentityStatement } from "@ghostly/core";
import type { IdentityProofProvider, InAppSigner, PublishSigner, SignerSession } from "../contract";
import { assertDomainRecord, assertNip05, chosenResolver, resolverById } from "../domain";
import { extensionSigner, withNostrSigner } from "../nostr";
import { nostr, nostrProofTemplate, type NostrEvent } from "./nostr";

/**
 * A domain the person controls (draft WISP 3xx, docs/wisps/3xx-domain.md).
 *
 * The statement ("I control domain:example.com and authorize the Ghostly key K …") is vouched for by
 * publishing, once, under the domain: a TXT record at `_ghostly.<domain>` or the file
 * `/.well-known/ghostly.json`, naming the proof key K and the statement id. The id commits the record to
 * the whole statement (dates and nonce too), so one published record vouches for exactly one proof. The
 * record names no contact and no conversation; sharing per contact is the contract's presentation.
 *
 * People who already run NIP-05 can instead sign the statement with the Nostr key their
 * `/.well-known/nostr.json` names for the domain itself (`_`): the proof holds only if both agree.
 */
export type DomainEvidence = { method: "dns" } | { method: "https" } | { method: "nip05"; event: NostrEvent };

const recordFor = (s: IdentityStatement): DomainRecord => ({ key: s.binding.key, proof: s.id });
const exactKeys = (raw: unknown, keys: string) => !!raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).sort().join(",") === keys;

const dnsSigner: PublishSigner<DomainEvidence> = {
  id: "dns", kind: "publish", label: "DNS TXT record",
  description: "Add a TXT record at your DNS host. Contacts' apps look it up through a DNS-over-HTTPS resolver.",
  instructions(statement) {
    const domain = statement.binding.subject;
    return { steps: [
      { text: `Open the DNS settings of ${domain} at your registrar or DNS host and add a TXT record with this name. Some hosts add the domain themselves: then enter only the part before ${domain}.`, copy: dnsProofName(domain) },
      { text: "Value (one string, exactly as shown):", copy: domainTxtRecord(recordFor(statement)) },
      { text: "Set the TTL to 300 seconds or less, so removing the record takes effect quickly. Then press Check: DNS changes can take a few minutes to appear." },
      { text: "The record stays public while the proof is in use. Removing it withdraws this proof from every contact at their next check." },
    ] };
  },
  evidence: () => ({ method: "dns" }),
};

const httpsSigner: PublishSigner<DomainEvidence> = {
  id: "https", kind: "publish", label: "File on your website",
  description: "Upload a small file to your website. Contacts' apps download it from your server.",
  instructions(statement) {
    const domain = statement.binding.subject;
    return { steps: [
      { text: `Create this file on the web server of ${domain}:`, copy: wellKnownUrl(domain) },
      { text: "With exactly this content:", copy: domainWellKnownFile([recordFor(statement)]) },
      { text: "Serve it over HTTPS at exactly that address, without any redirect (not even to www), and with this header so browsers may read it:", copy: "Access-Control-Allow-Origin: *" },
      { text: "Then press Check. The file stays public while the proof is in use; deleting it withdraws this proof from every contact at their next check." },
    ] };
  },
  evidence: () => ({ method: "https" }),
};

const domainField = { name: "domain", label: "Domain", kind: "text", placeholder: "example.com",
  help: "Its /.well-known/nostr.json must name this Nostr key for \"_\" (the domain itself)." } as const;

/** NIP-05: the statement is signed by the Nostr key the domain's nostr.json names for itself. */
function nip05Signer(id: "nip05-nip07" | "nip05-nip46"): InAppSigner<DomainEvidence> {
  const extension = id === "nip05-nip07";
  return {
    id, kind: "in-app",
    label: extension ? "NIP-05 with a browser extension" : "NIP-05 with a remote signer",
    description: "Already run NIP-05? Sign with the Nostr key your domain's nostr.json names for itself. No new record needed.",
    fields: extension ? [domainField] : [domainField, { name: "bunker", label: "Signer connection link", kind: "secret", placeholder: "bunker://…" }],
    platforms: extension ? ["web", "desktop"] : undefined,
    available: extension ? () => !!extensionSigner() : undefined,
    run: (ctx, work) => {
      const domain = normalizeDomain(ctx.values.domain ?? "");
      return withNostrSigner({ bunker: extension ? undefined : ctx.values.bunker, signal: ctx.signal, onAuth: ctx.onAuthUrl }, signer => {
        const session: SignerSession<DomainEvidence> = {
          subject: async () => domain,
          sign: async statement => {
            ctx.onProgress("Approve the Ghostly identity statement in your signer.");
            return { method: "nip05", event: (await signer.signEvent(nostrProofTemplate(statement))) as NostrEvent };
          },
        };
        return work(session);
      });
    },
  };
}

export const domain: IdentityProofProvider<DomainEvidence> = {
  id: "domain",
  label: "Domain",
  category: "self-custodied",
  summary: "A DNS record or a file on your site",
  description: "Proves you control a domain name: publish a DNS TXT record or a file on its website, once. Contacts' apps look it up when you share it and can check again later.",
  limits: "Does not prove who runs the domain, only that whoever added the proof could publish under it.",
  platforms: ["web", "extension", "desktop"],
  subject: {
    label: "Domain", placeholder: "example.com",
    help: "A domain or subdomain you control. A proof for alice.example.com is published under alice.example.com.",
    normalize: normalizeDomain,
  },
  publicUri: domain => `https://${domain}`,
  validity: { defaultDays: 90, maxDays: 365 },
  recheck: { afterSeconds: 86_400 },
  privacy: "DNS: the contact's app asks the DNS-over-HTTPS resolver chosen in its settings (Quad9 by default; the next of Quad9, Cloudflare and Google when it cannot be reached) for the record, " +
    "so that resolver learns the domain was checked. Website or NIP-05: the resolver learns the domain, and the domain's web server sees the contact's IP address.",
  signers: [dnsSigner, httpsSigner, nip05Signer("nip05-nip07"), nip05Signer("nip05-nip46")],
  parseEvidence(raw) {
    const e = raw as DomainEvidence;
    if (exactKeys(raw, "method") && (e.method === "dns" || e.method === "https")) return { method: e.method };
    if (exactKeys(raw, "event,method") && e.method === "nip05") return { method: "nip05", event: nostr.parseEvidence((e as { event: unknown }).event) };
    throw new Error("That is not domain proof evidence");
  },
  async verify(statement, evidence, ctx) {
    const subject = statement.binding.subject;
    if (normalizeDomain(subject) !== subject) throw new Error("The domain is not in canonical form");
    const resolver = chosenResolver();
    const options = { fetch: ctx.fetch, signal: ctx.signal, resolver: resolver.id, now: () => ctx.now * 1000 };
    if (evidence.method === "nip05") {
      // The same checks as a Nostr proof, for the key that signed; then the domain must name that key.
      await nostr.verify({ ...statement, binding: { ...statement.binding, subject: evidence.event.pubkey } }, evidence.event, ctx);
      await assertNip05(subject, evidence.event.pubkey, options);
      return { subject, source: `Nostr signature by the key ${wellKnownUrl(subject, "nip05")} names for ${subject}` };
    }
    const found = await assertDomainRecord(subject, evidence.method, recordFor(statement), options);
    return { subject, source: evidence.method === "dns"
      ? `DNS TXT record at ${dnsProofName(subject)}, via ${resolverById(found.resolver).name}${found.dnssec ? ", DNSSEC validated" : ""}`
      : `File at ${wellKnownUrl(subject)}` };
  },
};

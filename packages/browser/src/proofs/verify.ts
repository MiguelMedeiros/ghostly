import { boundVerifiedIdentity, IDENTITY_MAX_EVIDENCE, IDENTITY_MAX_VALIDITY, type IdentityStatement, type VerifiedIdentity } from "@ghostly/core";
import type { IdentityFetch, IdentityProofProvider, IdentitySigner, VerifyContext } from "./contract";

const DAY = 86_400;

/**
 * The checks every proof goes through, whatever its provider: known provider, validity within the
 * provider's limit, bounded evidence, strict parsing, the provider's own check, and the category rule
 * (a self-custodied proof proves exactly the subject it names; an attested one says who attests it).
 * The engine verifies a contact's proof, and the person's own proof before saving it, only through this.
 */
export async function verifyIdentity(providers: readonly IdentityProofProvider[], statement: IdentityStatement, evidence: unknown, ctx: VerifyContext): Promise<VerifiedIdentity> {
  const { binding } = statement;
  const provider = providers.find(p => p.id === binding.provider);
  if (!provider) throw new Error("This app cannot verify this kind of identity");
  if (binding.expiresAt - binding.issuedAt > Math.min(provider.validity.maxDays * DAY, IDENTITY_MAX_VALIDITY)) throw new Error("The proof lasts longer than this kind of identity allows");
  if (JSON.stringify(evidence ?? null).length > IDENTITY_MAX_EVIDENCE) throw new Error("Evidence too large");
  const parsed = provider.parseEvidence(evidence);
  const verified = boundVerifiedIdentity(await provider.verify(statement, parsed, ctx));
  if (provider.category === "self-custodied" && verified.subject !== binding.subject) throw new Error("The evidence is for another identity");
  if (provider.category === "provider-attested" && !verified.attester) throw new Error("The evidence does not say who attests it");
  return verified;
}

/** Problems with a provider's descriptor, empty when it is well-formed. The registry and the contract suite use it. */
export function descriptorProblems(p: IdentityProofProvider): string[] {
  const problems: string[] = [];
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(p.id)) problems.push("id must match ^[a-z][a-z0-9-]{0,31}$");
  if (!p.label?.trim()) problems.push("label is empty");
  if (!p.description?.trim()) problems.push("description is empty");
  if (!p.privacy?.trim()) problems.push("privacy is empty: say what verify contacts");
  if (p.category !== "self-custodied" && p.category !== "provider-attested") problems.push("category is unknown");
  if (!p.platforms.length) problems.push("no platforms");
  const { defaultDays, maxDays } = p.validity;
  if (!(Number.isInteger(defaultDays) && Number.isInteger(maxDays) && defaultDays >= 1 && defaultDays <= maxDays && maxDays * DAY <= IDENTITY_MAX_VALIDITY)) problems.push("validity must be whole days, 1 ≤ default ≤ max ≤ 400");
  if (p.recheck && !(Number.isInteger(p.recheck.afterSeconds) && p.recheck.afterSeconds >= 60)) problems.push("recheck.afterSeconds must be at least 60");
  if (!p.signers.length) problems.push("no signers");
  const ids = p.signers.map(s => s.id);
  if (new Set(ids).size !== ids.length) problems.push("signer ids are not unique");
  for (const s of p.signers as readonly IdentitySigner<unknown>[]) {
    if (!["in-app", "external-tool", "redirect", "publish"].includes(s.kind)) problems.push(`signer ${s.id} has an unknown kind`);
    if (s.kind === "in-app" && typeof s.run !== "function") problems.push(`signer ${s.id} has no run()`);
    if (s.kind === "external-tool" && (typeof s.instructions !== "function" || typeof s.parse !== "function")) problems.push(`signer ${s.id} needs instructions() and parse()`);
    if (s.kind === "redirect" && typeof s.start !== "function") problems.push(`signer ${s.id} has no start()`);
    if (s.kind === "publish" && (typeof s.instructions !== "function" || typeof s.evidence !== "function")) problems.push(`signer ${s.id} needs instructions() and evidence()`);
  }
  return problems;
}

/** Signers of a provider that run on this platform and are available in this window. */
export function availableSigners<E>(p: IdentityProofProvider<E>, platform: IdentityProofProvider["platforms"][number]): IdentitySigner<E>[] {
  return p.signers.filter(s => (s.platforms ?? p.platforms).includes(platform) && (s.available?.() ?? true));
}

/**
 * The engine's `ctx.fetch`: HTTPS GET only, no credentials or referrer, a time-out, a size cap,
 * redirects refused unless asked for.
 * `online` false refuses everything (the person turned the network off).
 */
export function boundedIdentityFetch(options: { online: () => boolean; timeoutMs?: number; fetcher?: typeof fetch } = { online: () => true }): IdentityFetch {
  return async (url, { headers, maxBytes = 64 * 1024, signal, redirect = "error" } = {}) => {
    if (!options.online()) throw new Error("Offline: this identity cannot be checked now");
    const target = new URL(url);
    if (target.protocol !== "https:" || target.username || target.password) throw new Error("Identity checks use HTTPS only");
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
    const response = await (options.fetcher ?? fetch)(target.href, {
      headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", redirect,
    });
    if (Number(response.headers.get("content-length")) > maxBytes) throw new Error("Identity check response too large");
    const reader = response.body?.getReader();
    const parts: Uint8Array[] = [];
    let length = 0;
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > maxBytes) throw new Error("Identity check response too large");
          parts.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return { status: response.status, contentType: response.headers.get("content-type") ?? "", text: new TextDecoder().decode(bytes), bytes };
  };
}

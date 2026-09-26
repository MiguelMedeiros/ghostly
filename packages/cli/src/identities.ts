import { identityStatement, type IdentityBinding, type IdentityStatement } from "@ghostly/core";
import { IDENTITY_PROVIDERS } from "@ghostly/browser/proofs/registry";
import type { IdentityProofProvider, IdentitySigner, SignerInstructions } from "@ghostly/browser/proofs/contract";
import type { IdentityProofView } from "@ghostly/browser/shared/types";
import { chatOf, node, num, state, str, type ApiContext, type Method, type Params } from "./apiKit";
import { CliError } from "./errors";

/**
 * Identity proofs (WISP 300, WISP 11xx phase 3b), as the Identities page makes them: the engine draws the proof key
 * and the statement; a signer of the provider makes the evidence; the engine checks it as a contact would before it
 * keeps it. Signers run here, where the app runs them in its page:
 *
 * - `external-tool` (ssh-keygen, gpg, a Bitcoin wallet): `identity add` prints the statement and what to run, and
 *   `identity complete` takes what the tool printed. Between the two the draft lives in the daemon's memory.
 * - `publish` (a DNS record, a file on a domain): the same, and `complete` asks the engine to look it up.
 * - `in-app` (a Nostr signer over NIP-46, Pubky, AT Protocol): one `identity add`, with the signer's fields; a link
 *   or code the signer waits on is reported as an `identity.approval` event and printed by the command.
 * - `redirect` (OpenID Connect) needs a browser window: app only.
 */

interface Draft { draftId: string; provider: string; signer: string; binding: IdentityBinding; createdAt: number }
/** Drafts per daemon: a proof made in two steps needs the same process for both. */
const drafts = new Map<string, Draft>();
const DRAFT_TTL_MS = 60 * 60 * 1000;

function provider(id: string): IdentityProofProvider {
  const found = IDENTITY_PROVIDERS.find((p) => p.id === id);
  if (!found) throw new CliError("not_found", `No identity provider ${id} (ghostly identity providers)`);
  return found;
}

function signerOf(p: IdentityProofProvider, id?: string): IdentitySigner<unknown> {
  const usable = p.signers.filter((s) => s.kind !== "redirect");
  const found = id ? p.signers.find((s) => s.id === id) : usable[0];
  if (!found) throw new CliError(id ? "not_found" : "unavailable", id ? `${p.label} has no signer ${id}` : `${p.label} proofs need a browser window: make them in the app`);
  if (found.kind === "redirect") throw new CliError("unavailable", `${found.label} signs in through a browser window: make this proof in the app`);
  return found as IdentitySigner<unknown>;
}

function instructionsJson(i: SignerInstructions) {
  return { steps: i.steps.map((s) => ({ text: s.text, ...(s.copy ? { copy: s.copy } : {}) })), ...(i.paste ? { paste: i.paste.label } : {}) };
}

export function proofJson(p: IdentityProofView) {
  return {
    id: p.id, provider: p.provider, subject: p.subject, verified: p.verified, issuedAt: p.issuedAt, expiresAt: p.expiresAt,
    sharedWith: p.sharedWith, ...(p.publicUri ? { publicUri: p.publicUri } : {}),
  };
}

function pruneDrafts(now = Date.now()) {
  for (const [id, draft] of drafts) if (now - draft.createdAt > DRAFT_TTL_MS) drafts.delete(id);
}

async function begin(ctx: ApiContext, p: IdentityProofProvider, subject: string, params: Params) {
  const normalized = p.subject?.normalize ? p.subject.normalize(subject) : subject;
  if (!normalized) throw new CliError("bad_request", `Not a ${p.subject?.label ?? "subject"} ${p.label} takes`);
  const days = params.days === undefined ? undefined : num(params, "days", 0, { min: 1, max: 400 });
  return node(ctx).beginIdentityProof({ provider: p.id, subject: normalized, ...(days ? { validityDays: days } : {}) });
}

export const IDENTITY_METHODS: Record<string, Method> = {
  async "identity.providers"() {
    return {
      providers: IDENTITY_PROVIDERS.map((p) => ({
        id: p.id, label: p.label, category: p.category, subject: p.subject ? { label: p.subject.label, placeholder: p.subject.placeholder ?? null } : null,
        signers: p.signers.map((s) => ({ id: s.id, kind: s.kind, label: s.label, headless: s.kind !== "redirect",
          ...(s.kind === "in-app" && s.fields ? { fields: s.fields.map((f) => ({ name: f.name, label: f.label, kind: f.kind, optional: !!f.optional })) } : {}) })),
      })),
    };
  },

  async "identity.list"(ctx) {
    return { proofs: state(ctx).identityProofs.map(proofJson) };
  },

  /** Starts a proof. In-app signers finish it here; the others return the statement and what to do with it. */
  async "identity.add"(ctx, params) {
    pruneDrafts();
    const p = provider(str(params, "provider", true));
    const signer = signerOf(p, str(params, "signer"));
    if (signer.kind === "in-app") {
      const values = (params.fields ?? {}) as Record<string, string>;
      if (typeof values !== "object" || Array.isArray(values) || Object.values(values).some((v) => typeof v !== "string")) throw new CliError("bad_request", "fields must be an object of strings");
      for (const field of signer.fields ?? []) if (!field.optional && !values[field.name]) throw new CliError("bad_request", `${signer.label} needs ${field.name} (${field.label})`);
      const signal = AbortSignal.timeout(num(params, "timeout", 300, { min: 5, max: 3600 }) * 1000);
      const proof = await signer.run({
        values, signal,
        onAuthUrl: (url) => { ctx.hub.emit("identity.approval", `identity.approval:${Date.now()}`, { provider: p.id, url }); },
        onProgress: (message) => { ctx.hub.emit("identity.progress", `identity.progress:${Date.now()}`, { provider: p.id, message }); },
        onApproval: (request) => {
          if (request) ctx.hub.emit("identity.approval", `identity.approval:${Date.now()}`, { provider: p.id, ...(request.qr ? { qr: request.qr.value, label: request.qr.label } : {}), notes: request.notes ?? [] });
        },
      }, async (session) => {
        const { draftId, binding } = await begin(ctx, p, await session.subject(), params);
        try {
          return await node(ctx).completeIdentityProof({ draftId, evidence: await session.sign(identityStatement(binding)) });
        } catch (error) {
          try { await node(ctx).cancelIdentityProof({ draftId }); } catch { /* already gone */ }
          throw error;
        }
      });
      return { done: true, proof: proofJson(proof) };
    }
    if (signer.kind === "redirect") throw new CliError("unavailable", `${signer.label} needs a browser window: make this proof in the app`);
    const { draftId, binding } = await begin(ctx, p, str(params, "subject", true), params);
    const statement = identityStatement(binding);
    drafts.set(draftId, { draftId, provider: p.id, signer: signer.id, binding, createdAt: Date.now() });
    return { done: false, draft: draftId, provider: p.id, signer: signer.id, statement: statement.text, instructions: instructionsJson(signer.instructions(statement)), expiresInSeconds: DRAFT_TTL_MS / 1000 };
  },

  /** Finishes a two-step proof: what the tool printed (external-tool), or nothing (publish: the engine looks it up). */
  async "identity.complete"(ctx, params) {
    const draft = drafts.get(str(params, "draft", true));
    if (!draft) throw new CliError("not_found", "No such draft here: it is kept by the daemon that made it, for an hour");
    const p = provider(draft.provider);
    const signer = signerOf(p, draft.signer);
    const statement: IdentityStatement = identityStatement(draft.binding);
    let evidence: unknown;
    try {
      if (signer.kind === "external-tool") evidence = await signer.parse(str(params, "evidence", true), statement);
      else if (signer.kind === "publish") evidence = await signer.evidence(statement);
      else throw new CliError("bad_request", "This draft needs no completion");
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError("bad_request", error instanceof Error ? error.message : String(error));
    }
    const proof = await node(ctx).completeIdentityProof({ draftId: draft.draftId, evidence });
    drafts.delete(draft.draftId);
    return { done: true, proof: proofJson(proof) };
  },

  async "identity.cancel"(ctx, params) {
    const draftId = str(params, "draft", true);
    drafts.delete(draftId);
    await node(ctx).cancelIdentityProof({ draftId });
    return { cancelled: draftId };
  },

  async "identity.remove"(ctx, params) {
    await node(ctx).removeIdentityProof({ id: str(params, "id", true) });
    return { removed: str(params, "id", true) };
  },

  async "identity.share"(ctx, params) {
    const link = chatOf(ctx, params);
    await node(ctx).shareIdentityProof({ linkId: link.id, id: str(params, "id", true) });
    return { chat: link.id, shared: str(params, "id", true) };
  },

  async "identity.withdraw"(ctx, params) {
    const link = chatOf(ctx, params);
    await node(ctx).withdrawIdentityProof({ linkId: link.id, id: str(params, "id", true) });
    return { chat: link.id, withdrawn: str(params, "id", true) };
  },

  /** What a contact shared in a chat, as this device checked it, and what this side shares there. */
  async "identity.contact"(ctx, params) {
    const link = chatOf(ctx, params);
    const view = link.identities;
    return {
      chat: link.id, support: view?.support ?? false,
      received: (view?.received ?? []).map((r) => ({ id: r.id, provider: r.provider, subject: r.subject, status: r.status, verified: r.verified, verifiedAt: r.verifiedAt, checkedAt: r.checkedAt, expiresAt: r.expiresAt, error: r.error ?? null, recheckDue: r.recheckDue, ...(r.publicProfile ? { publicProfile: r.publicProfile } : {}) })),
      shared: view?.shared ?? [],
    };
  },

  async "identity.recheck"(ctx, params) {
    const link = chatOf(ctx, params);
    await node(ctx).recheckIdentityProof({ linkId: link.id, id: str(params, "id", true) });
    return IDENTITY_METHODS["identity.contact"](ctx, { chat: link.id });
  },
};

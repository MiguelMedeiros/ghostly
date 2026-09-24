import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { npubEncode, decode as nip19Decode } from "nostr-tools/nip19";
import { utf8Encode, type IdentityStatement } from "@ghostly/core";
import type { IdentityProofProvider, InAppSigner, SignerSession } from "../contract";
import { extensionSigner, withNostrSigner } from "../nostr";

/** A signed Nostr event (NIP-01). The evidence of a Nostr proof. */
export interface NostrEvent { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string }

/**
 * NIP-78 application data (kind 30078): no new kind is claimed. Signers show it as such; it is never
 * published to a relay — the event travels only to the contacts the person shares it with.
 */
export const NOSTR_PROOF_KIND = 30078;
const HEX64 = /^[a-f0-9]{64}$/;

/** The exact event a signer is asked to sign: the statement as content, dated at issue, expiring with it. */
export function nostrProofTemplate(statement: IdentityStatement) {
  const { issuedAt, expiresAt } = statement.binding;
  return { kind: NOSTR_PROOF_KIND, created_at: issuedAt, content: statement.text,
    tags: [["d", "ghostly-identity-proof"], ["expiration", String(expiresAt)]] };
}

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g)!, x => parseInt(x, 16));

function normalizeNostrKey(input: string): string {
  const value = input.trim();
  if (HEX64.test(value.toLowerCase())) return value.toLowerCase();
  if (value.startsWith("npub1")) {
    try { const decoded = nip19Decode(value); if (decoded.type === "npub") return decoded.data; } catch { /* fall through */ }
  }
  throw new Error("Enter a Nostr public key: npub1… or 64 hex characters");
}

function nostrSigner(id: "nip07" | "nip46"): InAppSigner<NostrEvent> {
  return {
    id, kind: "in-app",
    label: id === "nip07" ? "Browser extension (NIP-07)" : "Remote signer (NIP-46)",
    description: id === "nip07" ? "Approve in the Nostr extension of this browser." : "Paste the bunker:// link from your signer app, then approve there.",
    fields: id === "nip46" ? [{ name: "bunker", label: "Signer connection link", kind: "secret", placeholder: "bunker://…" }] : undefined,
    platforms: id === "nip07" ? ["web", "desktop"] : undefined,
    available: id === "nip07" ? () => !!extensionSigner() : undefined,
    run: (ctx, work) => withNostrSigner({ bunker: id === "nip46" ? ctx.values.bunker : undefined, signal: ctx.signal, onAuth: ctx.onAuthUrl }, signer => {
      const session: SignerSession<NostrEvent> = {
        subject: async () => normalizeNostrKey(await signer.getPublicKey()),
        sign: async statement => {
          ctx.onProgress("Approve the Ghostly identity statement in your signer.");
          return (await signer.signEvent(nostrProofTemplate(statement))) as NostrEvent;
        },
      };
      return work(session);
    }),
  };
}

export const nostr: IdentityProofProvider<NostrEvent> = {
  id: "nostr",
  label: "Nostr",
  category: "self-custodied",
  description: "Proves you hold a Nostr key: your signer signs the statement, your key never leaves it.",
  platforms: ["web", "extension", "desktop"],
  subject: {
    label: "Public key", placeholder: "npub1…",
    normalize: normalizeNostrKey,
    short: key => { const npub = npubEncode(key); return `${npub.slice(0, 10)}…${npub.slice(-4)}`; },
  },
  validity: { defaultDays: 90, maxDays: 365 },
  privacy: "Nothing: the signature is checked on this device. The proof is never published to a relay.",
  signers: [nostrSigner("nip07"), nostrSigner("nip46")],
  parseEvidence(raw) {
    const e = raw as NostrEvent;
    if (!e || typeof e !== "object" || Array.isArray(e) || Object.keys(e).sort().join(",") !== "content,created_at,id,kind,pubkey,sig,tags" ||
      typeof e.id !== "string" || !HEX64.test(e.id) || typeof e.pubkey !== "string" || !HEX64.test(e.pubkey) ||
      typeof e.sig !== "string" || !/^[a-f0-9]{128}$/.test(e.sig) || !Number.isSafeInteger(e.kind) || !Number.isSafeInteger(e.created_at) ||
      typeof e.content !== "string" || e.content.length > 2048 || !Array.isArray(e.tags) || e.tags.length > 4 ||
      !e.tags.every(t => Array.isArray(t) && t.length <= 4 && t.every(x => typeof x === "string" && x.length <= 128)))
      throw new Error("That is not a signed Nostr event");
    return { id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags.map(t => [...t]), content: e.content, sig: e.sig };
  },
  async verify(statement, event) {
    const expected = nostrProofTemplate(statement);
    if (event.pubkey !== statement.binding.subject) throw new Error("Signed by another Nostr key");
    if (event.kind !== expected.kind || event.created_at !== expected.created_at || event.content !== expected.content ||
      JSON.stringify(event.tags) !== JSON.stringify(expected.tags)) throw new Error("The signer did not sign the exact Ghostly statement");
    // NIP-01 id, recomputed here: never trust the id or a verification flag the event carries.
    const id = hex(sha256(utf8Encode(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]))));
    if (event.id !== id) throw new Error("The Nostr event id does not match its content");
    let valid: boolean;
    try { valid = schnorr.verify(unhex(event.sig), unhex(id), unhex(event.pubkey)); } catch { valid = false; }
    if (!valid) throw new Error("Invalid Nostr signature");
    return { subject: event.pubkey, source: "Nostr signature (NIP-01, BIP-340)" };
  },
  // The public profile, follows and notes of a verified key are the Nostr social layer's
  // (engine/nostrSocial.ts): loaded on request from the relays the person configured, not here.
};

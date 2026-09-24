import { schnorr } from "@noble/curves/secp256k1.js";
import type { IdentityProofProvider, IdentityStatement } from "@ghostly/sdk";

/**
 * "Schnorr key": proves control of a BIP-340 key (an x-only secp256k1 public key, 64 hex characters)
 * by signing the statement with it. Two signers: one outside Ghostly (paste the signature back), and
 * one in the app that holds a key in memory, for tests. Nothing is fetched: the signature is checked on
 * the device. An example identity proof built with the SDK.
 */
const HEX64 = /^[a-f0-9]{64}$/, HEX128 = /^[a-f0-9]{128}$/;
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g)!, (b) => parseInt(b, 16));

export interface SchnorrEvidence { sig: string }

/** The key behind the in-app signer. Tests may replace it. */
export const schnorrKeyring = { secret: schnorr.utils.randomSecretKey() };
export const schnorrSubject = (secret = schnorrKeyring.secret) => hex(schnorr.getPublicKey(secret));
export const schnorrSign = (statement: IdentityStatement, secret = schnorrKeyring.secret): SchnorrEvidence => ({ sig: hex(schnorr.sign(statement.bytes, secret)) });

export const exampleSchnorr: IdentityProofProvider<SchnorrEvidence> = {
  id: "example-schnorr",
  label: "Schnorr key (SDK example)",
  category: "self-custodied",
  summary: "Sign once with a BIP-340 key",
  description: "Proves you hold a BIP-340 key: sign the statement with it. An example built with the SDK.",
  platforms: ["web", "extension", "desktop"],
  subject: {
    label: "Public key", placeholder: "64 hex characters (x-only)",
    normalize: (input) => { const v = input.trim().toLowerCase(); if (!HEX64.test(v)) throw new Error("Enter the x-only public key: 64 hex characters"); return v; },
    short: (k) => `${k.slice(0, 8)}…${k.slice(-4)}`,
  },
  validity: { defaultDays: 90, maxDays: 365 },
  privacy: "Nothing: the signature is checked on this device.",
  experimental: true,
  signers: [
    {
      id: "paste", kind: "external-tool", label: "Sign outside Ghostly",
      instructions: (statement) => ({
        steps: [{ text: "Sign these exact bytes with your key (BIP-340, no newline):", copy: statement.text }],
        paste: { label: "Signature (hex)", placeholder: "128 hex characters" },
      }),
      parse: (pasted) => { const sig = pasted.trim().toLowerCase(); if (!HEX128.test(sig)) throw new Error("That is not a Schnorr signature (128 hex characters)"); return { sig }; },
    },
    {
      id: "memory", kind: "in-app", label: "Key held by this page (tests)",
      run: async (ctx, work) => { ctx.signal.throwIfAborted(); return work({ subject: async () => schnorrSubject(), sign: async (statement) => schnorrSign(statement) }); },
    },
  ],
  parseEvidence(raw) {
    const e = raw as SchnorrEvidence;
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).join() !== "sig" || typeof e.sig !== "string" || !HEX128.test(e.sig)) throw new Error("Invalid signature evidence");
    return { sig: e.sig };
  },
  async verify(statement, evidence) {
    let ok: boolean;
    try { ok = schnorr.verify(unhex(evidence.sig), statement.bytes, unhex(statement.binding.subject)); } catch { ok = false; }
    if (!ok) throw new Error("The signature does not match this key and statement");
    return { subject: statement.binding.subject, source: "Schnorr signature (BIP-340) over the statement" };
  },
};

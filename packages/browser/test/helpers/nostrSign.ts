import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8Encode, type IdentityStatement } from "@ghostly/core";
import { nostrProofTemplate, type NostrEvent } from "../../src/proofs/providers/nostr";

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g)!, x => parseInt(x, 16));

/** What a NIP-07 or NIP-46 signer returns for the template, signed with a test key. */
export function signNostr(statement: IdentityStatement, secret: Uint8Array): NostrEvent {
  const t = nostrProofTemplate(statement);
  const pubkey = hex(schnorr.getPublicKey(secret));
  const id = hex(sha256(utf8Encode(JSON.stringify([0, pubkey, t.created_at, t.kind, t.tags, t.content]))));
  return { ...t, pubkey, id, sig: hex(schnorr.sign(unhex(id), secret)) };
}

import { fromZ32, randomBytes, toZ32 } from "./bytes";
import type { IdentityStatement } from "./identityProofs";

/**
 * A Pubky identity proof, by publication (WISP 302, docs/wisps/302-pubky.md). Neither Pubky Ring nor Pubky
 * Passport signs arbitrary text: they approve standard Pubky auth requests. So Ghostly asks, through one of them,
 * for write access to ONE fresh folder of the key's homeserver, `/pub/ghostly.app/proofs/<folder>/`, and writes the
 * identity statement there (the #80 statement: the Pubky key authorizes this profile's per-proof key). A contact's
 * app reads the file back, finding the homeserver through the key's own signed PKDNS records (pkdns.ts), never
 * through a host or URL from the proof. The folder is random, so the path says nothing about the profile.
 */

export const PUBKY_PROOF_ROOT = "/pub/ghostly.app/proofs/";
/** The file is the statement, a few hundred bytes: anything larger is not ours. */
export const PUBKY_PROOF_MAX_BYTES = 1024;
const Z32 = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/;
const FOLDER = /^[a-f0-9]{64}$/;
const STATEMENT_ID = /^[a-f0-9]{64}$/;

/** A canonical Pubky key: 52 characters of z-base-32 that decode to 32 bytes and back. */
export function isPubkyKey(value: unknown): value is string {
  if (typeof value !== "string" || !Z32.test(value)) return false;
  try { return toZ32(fromZ32(value)) === value; } catch { return false; }
}

/** The z-base-32 key for what a person typed or pasted: the bare key, `pubky<key>`, `pk:<key>` or `pubky://<key>`. */
export function normalizePubkyKey(input: string): string {
  const match = /^(?:pubky:\/\/|pubky|pk:)?([a-z0-9]{52})\/?$/i.exec(typeof input === "string" ? input.trim() : "");
  const key = match?.[1].toLowerCase();
  if (!key || !isPubkyKey(key)) throw new Error("That is not a Pubky key: 52 characters, like the one Pubky Ring shows");
  return key;
}

export const isPubkyProofFolder = (value: unknown): value is string => typeof value === "string" && FOLDER.test(value);

/** A fresh folder name: 32 random bytes, hex. One per proof, so two proofs never share a path. */
export const newPubkyProofFolder = () => Array.from(randomBytes(32), b => b.toString(16).padStart(2, "0")).join("");

/** The only capability Ghostly ever asks for: write access to one proof folder. */
export function pubkyProofCapability(folder: string): `/pub/${string}/:w` {
  if (!isPubkyProofFolder(folder)) throw new Error("Invalid Pubky proof folder");
  return `${PUBKY_PROOF_ROOT}${folder}/:w`;
}

/** Where the statement goes: in its folder, named by the statement id. */
export function pubkyProofPath(folder: string, statementId: string): `/pub/${string}` {
  if (!isPubkyProofFolder(folder) || !STATEMENT_ID.test(statementId)) throw new Error("Invalid Pubky proof path");
  return `${PUBKY_PROOF_ROOT}${folder}/${statementId}.txt`;
}

/** The file's exact contents: the statement's one line, nothing added. The verifier compares bytes. */
export const pubkyProofFile = (statement: IdentityStatement): string => statement.text;

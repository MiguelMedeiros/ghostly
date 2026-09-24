import { fromBase64Url, toBase64Url, utf8Encode } from "./bytes";
import { sanitizeAvatar } from "./avatar";
import { decryptText, encryptText, sha256Hex } from "./groupCrypto";
import { GROUP_ID, MEMBER_KEY } from "./groupCommits";
import { publicKeyFromZ32, sign, verify } from "./identity";

/**
 * A group's metadata (WISP 9xx § Metadata): what the group looks like, beside who is in it. Today
 * that is its picture. It is not in the membership chain, so apps that know nothing of it keep
 * verifying the chain as before and drop the frame that carries it.
 *
 * The admin signs a **statement**: the group, a commit of the chain (`e`, `h`) the admin was the
 * admin of, a revision `r`, and the SHA-256 of the **body**, the metadata itself as JSON. The body
 * is the whole metadata: a field left out is unset, so `{}` removes the picture. It travels in a
 * `group-meta` frame, encrypted under the message key of an epoch the recipient holds (`k`), so
 * someone taken out of the group cannot read what comes after, and any member can hand it on under
 * a later epoch without the admin: the signature covers the body's hash, not its box.
 *
 * Which statement a member keeps is the rule of each profile (the signer is the current admin; a
 * later commit wins, then a higher revision), in `GroupSession` and `CommunitySession`.
 */

/**
 * Longest picture (data URL) a group may have: less than a profile picture may be (`MAX_AVATAR_LENGTH`),
 * so the frame that carries it, sealed and in base64url, stays within the 60 KiB an edge takes.
 * What Ghostly makes (128×128) is a few kilobytes.
 */
export const MAX_GROUP_PICTURE_LENGTH = 40_000;
/** Longest body, in UTF-8 bytes: a picture and room for little else. */
export const MAX_GROUP_META_BODY = 42_000;
const MAX_META_BOX = Math.ceil((MAX_GROUP_META_BODY + 16) * 4 / 3) + 4;
const HASH = /^[a-f0-9]{64}$/;
const SIG = /^[A-Za-z0-9_-]{86}$/;
const B64 = /^[A-Za-z0-9_-]*$/;

/** What the body may say. Every field is optional; one left out is unset. */
export interface GroupMetaBody {
  /** The group's picture: a square JPEG data URL, as `sanitizeAvatar` accepts it. */
  pic?: string;
}

export interface GroupMetaStatement {
  g: string;
  /** The commit the admin signs under: its epoch (index in the chain) and hash. */
  e: number;
  h: string;
  /** Revision: higher wins under the same commit. */
  r: number;
  by: string;
  ts: number;
  /** SHA-256 (hex) of the body's UTF-8 bytes. */
  d: string;
  sig: string;
}

/** A statement with its body, as a member keeps it. */
export interface GroupMeta extends GroupMetaStatement {
  /** The body, exactly as signed (JSON). */
  body: string;
}

/**
 * `group-meta` on an edge. `k` names the epoch whose message key seals the body: an epoch
 * number in `group-mesh/1`, a commit hash in `group-community/1` (whose frames also carry `v: 2`).
 */
export interface GroupMetaFrame extends GroupMetaStatement {
  t: "group-meta";
  v?: 2;
  k: number | string;
  nn: string;
  c: string;
}

const statementBytes = (s: Omit<GroupMetaStatement, "sig">) =>
  utf8Encode(JSON.stringify(["ghostly-group meta", s.g, s.e, s.h, s.r, s.by, s.ts, s.d]));
const boxAad = (g: string, k: number | string, d: string) => JSON.stringify(["ghostly-group meta", g, k, d]);

/** The body for a picture (or none). Throws on a picture Ghostly would not show. */
export function encodeGroupMetaBody(body: GroupMetaBody): string {
  const out: GroupMetaBody = {};
  if (body.pic) {
    if (body.pic.length > MAX_GROUP_PICTURE_LENGTH || typeof sanitizeAvatar(body.pic) !== "string") throw new Error("This picture cannot be used");
    out.pic = body.pic;
  }
  return JSON.stringify(out);
}

/** A body as received: null when it is not JSON, too large, or its picture is not one Ghostly shows. Unknown fields are ignored. */
export function parseGroupMetaBody(body: string): GroupMetaBody | null {
  if (utf8Encode(body).length > MAX_GROUP_META_BODY) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const out: GroupMetaBody = {};
  const pic = (parsed as Record<string, unknown>).pic;
  if (pic !== undefined) {
    const clean = sanitizeAvatar(pic);
    if (clean === undefined || (clean && clean.length > MAX_GROUP_PICTURE_LENGTH)) return null;
    if (clean) out.pic = clean;
  }
  return out;
}

/** The admin's signature on a body under commit `h` (epoch `e`). */
export function signGroupMeta(fields: { g: string; e: number; h: string; r: number; ts: number }, body: string, seed: Uint8Array, by: string): GroupMeta {
  const unsigned = { ...fields, by, d: sha256Hex(utf8Encode(body)) };
  return { ...unsigned, sig: toBase64Url(sign(statementBytes(unsigned), seed)), body };
}

/** The statement's shape, from a frame or storage; null when anything is off. */
export function parseGroupMetaStatement(raw: unknown): GroupMetaStatement | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  if (typeof f.g !== "string" || !GROUP_ID.test(f.g) || !Number.isSafeInteger(f.e) || (f.e as number) < 0 || typeof f.h !== "string" || !HASH.test(f.h) ||
    !Number.isSafeInteger(f.r) || (f.r as number) < 1 || typeof f.by !== "string" || !MEMBER_KEY.test(f.by) || !Number.isSafeInteger(f.ts) || (f.ts as number) <= 0 ||
    typeof f.d !== "string" || !HASH.test(f.d) || typeof f.sig !== "string" || !SIG.test(f.sig)) return null;
  return { g: f.g, e: f.e as number, h: f.h, r: f.r as number, by: f.by, ts: f.ts as number, d: f.d, sig: f.sig };
}

/** Whether `by` signed this statement. */
export function verifyGroupMetaSignature(s: GroupMetaStatement): boolean {
  try { return verify(fromBase64Url(s.sig), statementBytes(s), publicKeyFromZ32(s.by)); } catch { return false; }
}

/** The frame that carries a statement and its body, sealed under the message key of epoch `k`. */
export function wrapGroupMeta(meta: GroupMeta, k: number | string, messageKey: Uint8Array, community = false): GroupMetaFrame {
  const { body, ...statement } = meta;
  const { n, c } = encryptText(messageKey, boxAad(meta.g, k, meta.d), body);
  return { t: "group-meta", ...(community ? { v: 2 as const } : {}), ...statement, k, nn: n, c };
}

/** The frame's statement and its key reference, before anything is opened; null when malformed. */
export function parseGroupMetaFrame(raw: unknown): { statement: GroupMetaStatement; k: number | string; nn: string; c: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  const statement = parseGroupMetaStatement(raw);
  if (f.t !== "group-meta" || !statement) return null;
  if (!((Number.isSafeInteger(f.k) && (f.k as number) >= 0) || (typeof f.k === "string" && HASH.test(f.k)))) return null;
  if (typeof f.nn !== "string" || f.nn.length !== 32 || !B64.test(f.nn) || typeof f.c !== "string" || f.c.length > MAX_META_BOX || !B64.test(f.c)) return null;
  return { statement, k: f.k as number | string, nn: f.nn, c: f.c };
}

/**
 * The body of a parsed frame, with the key of its epoch `k`: it must open, hash to what was signed
 * and be metadata Ghostly accepts. The signature is checked separately (`verifyGroupMetaSignature`).
 */
export function openGroupMeta(frame: { statement: GroupMetaStatement; k: number | string; nn: string; c: string }, messageKey: Uint8Array): { meta: GroupMeta; body: GroupMetaBody } | null {
  const body = decryptText(messageKey, boxAad(frame.statement.g, frame.k, frame.statement.d), frame.nn, frame.c);
  if (body === null || sha256Hex(utf8Encode(body)) !== frame.statement.d) return null;
  const parsed = parseGroupMetaBody(body);
  return parsed ? { meta: { ...frame.statement, body }, body: parsed } : null;
}

/** Is `a` later than `b`: signed under a later commit, or a higher revision under the same one. */
export function groupMetaNewer(a: { e: number; r: number }, b: { e: number; r: number } | undefined): boolean {
  return !b || a.e > b.e || (a.e === b.e && a.r > b.r);
}

/** What a sync frame says of the metadata a member holds (`e.r`, "" for none): old apps send nothing, and get nothing. */
export const groupMetaTag = (meta: { e: number; r: number } | undefined): string => meta ? `${meta.e}.${meta.r}` : "";
export function parseGroupMetaTag(tag: unknown): { e: number; r: number } | undefined | null {
  if (tag === "") return undefined;
  if (typeof tag !== "string" || !/^\d{1,15}\.\d{1,15}$/.test(tag)) return null;
  const [e, r] = tag.split(".").map(Number);
  return { e, r };
}

/** The picture a kept statement's body names, if it is one Ghostly shows. */
export function groupMetaPicture(meta: GroupMeta | undefined): string | undefined {
  return meta ? parseGroupMetaBody(meta.body)?.pic : undefined;
}

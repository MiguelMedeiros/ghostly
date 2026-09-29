import { sha256 } from "@noble/hashes/sha2.js";
import { toBase64Url, utf8Encode } from "./bytes";
import { LIMITS } from "./frames";
import { parseLinkPreview, type LinkPreview } from "./linkPreview";

/**
 * Editing a sent text in a 1:1 chat (WISP 401 § Edits). The sender says the whole new text of one of its own
 * messages, with a sequence number of its own per message, and the contact confirms the number it now shows:
 *
 *     {"t":"paired-edit","id":"<the message's wire id>","e":3,"ts":1790000000000,"m":"Done: 12 of 12"}
 *     {"t":"paired-edited","id":"<the message's wire id>","e":3}
 *
 * It needs `edit/1` in `paired-capabilities` on both sides. Only the contact's own messages can be edited from its
 * side: the frame comes on the session authenticated with the pinned contact, and the receiver looks the id up among
 * that contact's messages only. The highest `e` wins, whatever order frames arrive in; an edit that is not newer is
 * confirmed and changes nothing. A preview (`pv`, WISP 401 § Link previews) may come with the new text, as with a
 * message. Older apps drop both frames: they have an id, but a `t` they do not know.
 */

export const EDIT_FRAME = "paired-edit";
export const EDITED_FRAME = "paired-edited";

/** Edits one message takes; the sender refuses the next one and the receiver ignores a higher number. */
export const MAX_EDITS_PER_MESSAGE = 100;

/** A sender says at most this many edits per `EDIT_RATE_WINDOW_MS` in one chat; the newest text of each message waits. */
export const EDIT_SEND_LIMIT = 10;
/** A receiver takes at most this many edit frames per window; the rest are dropped unconfirmed, so they come again. */
export const EDIT_RECEIVE_LIMIT = 30;
export const EDIT_RATE_WINDOW_MS = 10_000;

/** An edit of a message not here yet waits this long for it, at most `EDIT_BUFFER_MAX` of them per chat. */
export const EDIT_BUFFER_MS = 60_000;
export const EDIT_BUFFER_MAX = 32;

const ID = /^[A-Za-z0-9_-]{22}$/;

/** One edit as it goes on the wire. */
export interface WireEdit {
  /** The edited message's wire id. */
  id: string;
  /** Its edit number, 1 for the first edit. */
  e: number;
  /** When the sender made the edit (milliseconds). */
  ts: number;
  /** The whole new text. */
  m: string;
  pv?: LinkPreview;
}

/** Largest edit frame sent with a preview: the preview is left out past it, as with a message. */
const MAX_EDIT_FRAME = 56 * 1024;

/** A `paired-edit` frame; the preview is left out when the frame would be too large with it. */
export function editFrame(edit: WireEdit): string {
  const plain = JSON.stringify({ t: EDIT_FRAME, id: edit.id, e: edit.e, ts: edit.ts, m: edit.m });
  if (!edit.pv) return plain;
  const withPreview = JSON.stringify({ t: EDIT_FRAME, id: edit.id, e: edit.e, ts: edit.ts, m: edit.m, pv: edit.pv });
  return withPreview.length <= MAX_EDIT_FRAME ? withPreview : plain;
}

/** The frame that confirms edit `e` of message `id`. */
export function editedFrame(id: string, e: number): string {
  return JSON.stringify({ t: EDITED_FRAME, id, e });
}

/** An edit number a message can have. */
export function validEditNumber(e: unknown): e is number {
  return Number.isSafeInteger(e) && (e as number) >= 1 && (e as number) <= MAX_EDITS_PER_MESSAGE;
}

/** A message's new text: not empty, no space around it, within a chat message's bytes. The same on a session and on the DHT. */
export function validEditMessage(m: unknown): m is string {
  return typeof m === "string" && !!m.trim() && m === m.trim() && utf8Encode(m).length <= LIMITS.maxChatMessageBytes;
}

/**
 * The edit a `paired-edit` frame says, or null when it is malformed (then it says nothing and is not confirmed). A
 * preview that does not hold is dropped, never the edit.
 */
export function parseEditFrame(frame: Record<string, unknown>): WireEdit | null {
  if (frame?.t !== EDIT_FRAME) return null;
  const { id, e, ts, m } = frame;
  if (typeof id !== "string" || !ID.test(id) || !validEditNumber(e)) return null;
  if (typeof ts !== "number" || !Number.isSafeInteger(ts) || ts <= 0) return null;
  if (!validEditMessage(m)) return null;
  const pv = frame.pv === undefined ? undefined : parseLinkPreview(frame.pv, m);
  return { id, e, ts, m, ...(pv && { pv }) };
}

/** The confirmation a `paired-edited` frame says, or null when it is malformed. */
export function parseEditedFrame(frame: Record<string, unknown>): { id: string; e: number } | null {
  if (frame?.t !== EDITED_FRAME) return null;
  return typeof frame.id === "string" && ID.test(frame.id) && validEditNumber(frame.e) ? { id: frame.id, e: frame.e } : null;
}

/**
 * The id an edit goes by on the DHT floor (WISP 403 § Edits): a text of its own there, with the edited message's id and
 * the edit's number beside it. The same for every send of the same edit, so its retries and its receipt match.
 */
export function dhtEditId(id: string, e: number): string {
  return toBase64Url(sha256(utf8Encode(`ghostly-edit/1:${id}:${e}`)).slice(0, 16));
}

/** A sliding window of `limit` events per `windowMs`: the sender's pace and the receiver's limit. */
export class RateWindow {
  private recent: number[] = [];

  constructor(private readonly limit: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}

  /** Counts one now; false (and not counted) when the window is full. */
  take(): boolean {
    const now = this.now();
    this.recent = this.recent.filter(at => now - at < this.windowMs);
    if (this.recent.length >= this.limit) return false;
    this.recent.push(now);
    return true;
  }

  /** Milliseconds until the window has room again; 0 when it has room now. */
  wait(): number {
    const now = this.now();
    this.recent = this.recent.filter(at => now - at < this.windowMs);
    return this.recent.length < this.limit ? 0 : this.recent[0] + this.windowMs - now;
  }

  reset(): void { this.recent = []; }
}

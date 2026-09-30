import { MEMBER_KEY } from "./groupCommits";
import { BUTTON_ID } from "./statusCards";
import { sanitizeDisplayText } from "./text";

/*
 * A reply to a message (WISP 400 § Replies): which earlier message of the same chat a new one answers, with a short
 * line of it and who wrote it, so the reply still reads when the receiver no longer has the original (deleted here,
 * or never received). The receiver shows the line only as the replier's app saw it; the original it finds in its own
 * history, by id, is what it trusts. An app without replies ignores the field and shows the text alone.
 */

/**
 * On the wire (`r`): `i` the original's id in this chat, `s` a line of it, `f` who wrote it. In a paired chat `f` is
 * `"sender"` (the reply's author wrote the original) or `"recipient"` (the reader did); in a group, a member key.
 * `b`: a button press (WISP 4xx · Message Buttons), the id of the original's button this reply presses; its text is
 * the button's label. An app from before buttons drops `b` and shows an ordinary reply.
 */
export interface WireReply { i: string; s: string; f: string; b?: string }

export const REPLY_LIMITS = {
  /** Code points of the line of the original, an ellipsis included when it was cut. */
  snippet: 120,
  /** Characters of the original's id. */
  id: 128,
  /** Characters of a line as it arrives, before it is cleaned: anything longer is not a line of a message. */
  raw: 2048,
} as const;

/** A paired chat's message id, a payment id or a file's wire id; a group message's `sender:epoch:seq`. */
export const REPLY_ID = /^[A-Za-z0-9_:.-]{1,128}$/;
/** The two authors a paired chat has, from the reply author's side. */
export const PAIRED_REPLY_AUTHORS = ["sender", "recipient"] as const;

/** A picture sent inline has no line worth quoting. */
const INLINE_PICTURE = /^data:image\//i;

/**
 * A line of a message to quote: plain text on one line (line breaks and runs of spaces become one space), without
 * control, invisible or direction characters (WISP 400, as for names), at most `REPLY_LIMITS.snippet` code points,
 * the last of them an ellipsis when it was cut.
 */
export function replySnippet(text: string): string {
  if (INLINE_PICTURE.test(text.trimStart())) return "🖼️ Picture";
  const flat = text.slice(0, REPLY_LIMITS.raw * 2).replace(/\s+/gu, " ");
  const clean = sanitizeDisplayText(flat, REPLY_LIMITS.snippet + 1) ?? "";
  const points = [...clean];
  return points.length > REPLY_LIMITS.snippet ? `${points.slice(0, REPLY_LIMITS.snippet - 1).join("").trimEnd()}…` : clean;
}

/**
 * A reply as a receiver takes it: an object with an id of this chat's shape, a line (cleaned and cut again here,
 * whatever the sender did) and an author `author` accepts. Anything else is no reply: the message stays, without it.
 */
export function readReply(raw: unknown, author: (f: string) => boolean): WireReply | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const { i, s, f, b } = raw as Record<string, unknown>;
  if (typeof i !== "string" || !REPLY_ID.test(i)) return undefined;
  if (typeof s !== "string" || s.length > REPLY_LIMITS.raw) return undefined;
  if (typeof f !== "string" || !author(f)) return undefined;
  // A press that does not hold is only a reply.
  return { i, s: replySnippet(s), f, ...(typeof b === "string" && BUTTON_ID.test(b) && { b }) };
}

/** Who may have written the original in a paired chat. */
export const pairedReplyAuthor = (f: string): boolean => (PAIRED_REPLY_AUTHORS as readonly string[]).includes(f);
/** Who may have written the original in a group: a member key (whether they are still a member is the reader's to see). */
export const groupReplyAuthor = (f: string): boolean => MEMBER_KEY.test(f);

/** Only the wire fields, in a fixed order, the line cleaned: what the sender puts on a frame. */
export const wireReply = (reply: WireReply): WireReply => ({ i: reply.i, s: replySnippet(reply.s), f: reply.f, ...(reply.b && { b: reply.b }) });

import type { AttentionCue } from "../shared/rpc";
import type { StoredMessage } from "../shared/types";
import { groupCue } from "./cues";

/*
 * Which stored rows make the app say something (a sound, a system notification): a new message from the contact or a
 * member, one that lands at the end of its chat, and what I sent. Everything else a chat's history gains is quiet:
 * a line of a group's history (someone joined, left, is the admin, renamed it), a file (its own cue says it is here),
 * a payment (the wallet's sounds say it), a join notice, a text with nothing to show, and a late catch-up of messages
 * that land among older ones instead of at the end (#506: not new there either). What never becomes a row is quiet
 * by construction: typing and a bot's status, edits, reactions, receipts, call signals, transport lines.
 */

/** A message this far behind the newest of its chat, and this old, is a catch-up, not news. Clocks disagree a little. */
export const CATCH_UP_SLACK_MS = 60_000;

const JOIN_NOTICE = /^👋 (?:.+ )?joined$/;

export interface MessageAttention { type: "message" | "sent"; mention: boolean; cue?: AttentionCue }

export interface AttentionContext {
  /** When this engine started: what was sent before it is history, heard already or not. */
  startedAt: number;
  /** The newest time already stored in the message's chat, while this engine runs; undefined when none. */
  newest?: number;
  now: number;
}

/** What a newly stored row says, or null when it is quiet. `type`: "message" for the contact's, "sent" for mine. */
export function messageAttention(type: "message" | "sent", message: StoredMessage, { startedAt, newest, now }: AttentionContext): MessageAttention | null {
  if (message.timestamp < startedAt || message.file || message.paymentId || JOIN_NOTICE.test(message.text)) return null;
  // A line of a group's history: only the one that says I made the group or joined it, as it always was.
  if (message.event) {
    const cue = groupCue(message);
    return cue && type === "message" ? { type, mention: false, cue } : null;
  }
  if (type === "sent") return { type, mention: false };
  if (!message.text.trim()) return null;
  if (newest !== undefined && message.timestamp < newest - CATCH_UP_SLACK_MS && now - message.timestamp > CATCH_UP_SLACK_MS) return null;
  return { type, mention: !!message.mentioned };
}

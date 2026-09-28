import { forwardedMany } from "@ghostly/core";
import { engine } from "@ghostly/browser/platform/engine";
import { findSecret, type SecretFinding } from "./parse/secrets";
import type { ChatMessage } from "./types";

/*
 * Forwarding in the UI (WISP 400 § Forwards): which messages have Forward, the label a forwarded one shows, and the
 * call that sends them on. The engine does the sending, one new message of mine per chat, and checks all of it again.
 */

/** At most this many chats and groups at once (the engine's `FORWARD_TARGETS`). */
export const FORWARD_MAX_TARGETS = 5;
/** At most this many messages at once (the engine's `FORWARD_MESSAGES`). */
export const FORWARD_MAX_MESSAGES = 30;

/**
 * Whether a message has Forward: a text or a file someone sent. Not a payment or a payment request, a call line or a
 * notice. A file still arriving keeps its Forward, greyed until it is all here.
 */
export function canForward(message: ChatMessage): boolean {
  if (message.sender !== "me" && message.sender !== "peer") return false;
  if (message.paymentId || message.systemEvent || message.callEvent) return false;
  return !!message.file || !!message.text.trim();
}

/** The label of a forwarded message's bubble: "Forwarded", or past a few hops "Forwarded many times". */
export function forwardedLabel(hops: number | undefined): "chat.forward.forwarded" | "chat.forward.many" | null {
  if (!hops) return null;
  return forwardedMany(hops) ? "chat.forward.many" : "chat.forward.forwarded";
}

/** The first text among these that looks like a seed, a key or ecash: asked about before it goes, as typing it would be. */
export function forwardSecret(messages: readonly ChatMessage[]): SecretFinding | null {
  for (const message of messages) {
    if (message.file) continue;
    const found = findSecret(message.text);
    if (found) return found;
  }
  return null;
}

/** What each chat forwarded to got, from the engine: the new messages and the first problem, if any. */
export interface ForwardOutcome { to: string; messageIds: string[]; error: string | null }

/**
 * Sends messages of a chat (`linkId`, or `group:<id>`) on to others (engine link ids or `group:<id>`), in the order they
 * were written. Throws when nothing could start (a message that cannot be forwarded, too many chats).
 */
export async function forwardMessages(linkId: string, messageIds: readonly string[], to: readonly string[]): Promise<ForwardOutcome[]> {
  const { results } = await engine.call("forwardMessages", { linkId, messageIds: [...messageIds], to: [...to] });
  return results;
}

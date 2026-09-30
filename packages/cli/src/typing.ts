import { TYPING_REFRESH_MS, type TypingKind } from "@ghostly/core";
import { node, type ApiContext } from "./apiKit";

/**
 * `typing --for` and `group typing --for`: a `start` holds 6 s on the other side (WISP 401 § Typing, WISP 9xx · Group
 * Mesh § Typing), so the daemon says it again until the time is up, a message goes to that chat or group, or a
 * `--stop`. The engine sends a `start` at most once per refresh, counted from when the last one went: asking every half
 * refresh missed the tick at 3 s by a millisecond about half the time, so a start went every 4.5 s, 1.5 s inside the
 * contact's 6 s, and a busy machine flickered the contact's indicator off and on. Asking every half second sends one
 * at most 3.5 s after the last, and soon again when the send limit held one back.
 */
const KEEP_EVERY_MS = TYPING_REFRESH_MS / 6;
const keepers = new WeakMap<ApiContext, Map<string, () => void>>();

/** Where typing is said: a 1:1 chat, or a private group. */
export type TypingTarget = { linkId: string } | { groupId: string };
type Word = { kind?: TypingKind; status?: string };

function keepersOf(ctx: ApiContext): Map<string, () => void> {
  let map = keepers.get(ctx);
  if (!map) keepers.set(ctx, (map = new Map()));
  return map;
}

const keyOf = (target: TypingTarget) => "groupId" in target ? `group:${target.groupId}` : target.linkId;

/** Says it once: this side is typing (with its word), or stopped. */
export function sayTyping(ctx: ApiContext, target: TypingTarget, typing: boolean, word: Word = {}): void {
  const said = typing ? word : {};
  if ("groupId" in target) node(ctx).setGroupTyping({ groupId: target.groupId, typing, ...said });
  else node(ctx).setTyping({ linkId: target.linkId, typing, ...said });
}

/**
 * Says this side is typing in the chat or group for `ms`, with the kind and status it gave (`--kind`, `--status`) each
 * time; resolves when that ends, whichever way.
 */
export function keepTyping(ctx: ApiContext, target: TypingTarget, ms: number, word: Word = {}): Promise<void> {
  endTyping(ctx, target, false);
  const map = keepersOf(ctx), key = keyOf(target);
  return new Promise<void>((resolve) => {
    const end = () => { clearInterval(again); clearTimeout(until); off(); if (map.get(key) === end) map.delete(key); resolve(); };
    const again = setInterval(() => sayTyping(ctx, target, true, word), KEEP_EVERY_MS);
    const until = setTimeout(() => { end(); sayTyping(ctx, target, false); }, ms);
    // A message ends it, sent from anywhere (the engine said `stop` with it).
    const off = ctx.hub.onEvent((event) => {
      if ("groupId" in target ? event.type === "group.sent" && event.group === target.groupId : event.type === "message.sent" && event.chat === target.linkId) end();
    });
    map.set(key, end);
  });
}

/** Ends a kept `--for` in the chat or group; `tell`: and says this side stopped. Whether one was kept. */
export function endTyping(ctx: ApiContext, target: TypingTarget, tell: boolean): boolean {
  const end = keepersOf(ctx).get(keyOf(target));
  if (!end) return false;
  end();
  if (tell) sayTyping(ctx, target, false);
  return true;
}

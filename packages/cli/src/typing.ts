import { sanitizeDisplayText, sanitizeTypingStatus, TYPING_REFRESH_MS, TYPING_STATUS_MAX, type TypingKind } from "@ghostly/core";
import type { EngineState } from "@ghostly/browser/shared/types";
import { node, state, type ApiContext } from "./apiKit";
import { CliError, type ErrorCode } from "./errors";

/**
 * `typing --for` and `group typing --for`: a `start` holds 6 s on the other side (WISP 401 § Typing, WISP 902 · Group
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

/**
 * A typing status as the contact's app shows it, checked as `status set` checks its text (ownStatus.ts): one line,
 * counted as shown, each refusal named by `name` (the command's `--status`, or the socket's `status`). Blank once trimmed
 * (spaces, an unset variable) is no status, as an empty one already was: it was refused as "no link or markup".
 */
export function typingStatus(raw: string | undefined, name: string, code: ErrorCode): string | undefined {
  const oneLine = raw?.replace(/\s+/g, " ").trim();
  if (!oneLine) return undefined;
  const shown = sanitizeDisplayText(oneLine, Infinity) ?? "";
  const length = [...shown].length;
  if (length > TYPING_STATUS_MAX) throw new CliError(code, `${name} is up to ${TYPING_STATUS_MAX} characters, not ${length} characters`);
  if (!shown) throw new CliError(code, `${name} needs a character that shows`);
  const status = sanitizeTypingStatus(shown);
  if (!status) throw new CliError(code, `${name} is plain text: no link or markup`);
  return status;
}

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

/** How long a one-shot's `--for` waits for its chat or group to be live: a fresh one-shot connects first. */
export const ONE_SHOT_LIVE_GRACE_MS = 15_000;

/**
 * A one-shot's `--for` (it holds the profile while it runs): kept the whole time once the chat or group is live, as a
 * daemon keeps it; ended when it is not live within `ONE_SHOT_LIVE_GRACE_MS`, since nobody would see it, and `--stop`
 * or a send from another shell could not end it. Whether it was live: false when it ended with nobody to see it (not
 * live in time, or its time or a send ended it first), so the answer says so rather than `typing: true`.
 */
export async function keepOneShot(ctx: ApiContext, target: TypingTarget, kept: Promise<void>, live: (state: EngineState) => boolean): Promise<boolean> {
  let stop = () => {};
  const cameLive = new Promise<boolean>((resolve) => {
    if (live(state(ctx))) return resolve(true);
    const timer = setTimeout(() => { off(); resolve(false); }, ONE_SHOT_LIVE_GRACE_MS);
    const off = ctx.hub.onState((next) => { if (live(next)) { clearTimeout(timer); off(); resolve(true); } });
    stop = () => { clearTimeout(timer); off(); resolve(true); };
  });
  const first = await Promise.race([kept.then(() => "ended" as const), cameLive]);
  if (first === false) { endTyping(ctx, target, false); return false; }
  stop();
  if (first === "ended") return live(state(ctx));
  await kept;
  return true;
}

/** Ends a kept `--for` in the chat or group; `tell`: and says this side stopped. Whether one was kept. */
export function endTyping(ctx: ApiContext, target: TypingTarget, tell: boolean): boolean {
  const end = keepersOf(ctx).get(keyOf(target));
  if (!end) return false;
  end();
  if (tell) sayTyping(ctx, target, false);
  return true;
}

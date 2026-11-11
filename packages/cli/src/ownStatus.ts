import { reactionEmoji, sanitizeDisplayText, sanitizeStatusText, STATUS_AVAILABILITIES, STATUS_TEXT_MAX, type PersonStatus, type StatusAvailability } from "@ghostly/core";
import { STATUS_CARD_LIMITS } from "@ghostly/core/statusCards";
import { CliError, type ErrorCode } from "./errors";

/**
 * This profile's status (WISP 401 § Presence and status): a text, one emoji, an availability and when it ends, said to
 * every paired contact whose app offers `status/1`: `status set|clear|show`, and the socket's `status.set|clear|get`.
 * These never say presence (active or idle): only a daemon does, and only with `settings set daemonPresence true`
 * (daemonPresence.ts); otherwise a headless profile never reads as online.
 */

/** What `status set` was given, before it is checked. */
export interface StatusInput { text?: string; emoji?: string; availability?: string; until?: number }

/**
 * The status as the engine keeps it (`personStatus`), checked first: the engine drops a field that does not hold
 * without a word (a long text cut, a word that is not one emoji left out, an end already past clearing the whole
 * status), so here each is refused instead, named by `name` (the command's option, or the socket's parameter).
 */
export function checkOwnStatus(input: StatusInput, name: (field: keyof StatusInput) => string, code: ErrorCode, now = Date.now()): PersonStatus {
  const fail = (field: keyof StatusInput, rule: string) => new CliError(code, `${name(field)} ${rule}`);
  const status: PersonStatus = {};
  if (input.availability !== undefined) {
    if (!(STATUS_AVAILABILITIES as readonly string[]).includes(input.availability)) throw fail("availability", `takes ${STATUS_AVAILABILITIES.join(", ")}, not ${JSON.stringify(input.availability)}`);
    status.availability = input.availability as StatusAvailability;
  }
  if (input.emoji !== undefined) {
    const emoji = reactionEmoji(input.emoji);
    if (!emoji) throw fail("emoji", `takes one emoji, not ${JSON.stringify(input.emoji)}`);
    status.emoji = emoji;
  }
  // One line, as contacts see it: a line break or a run of spaces is one space; invisible characters are not counted.
  const oneLine = input.text?.replace(/\s+/g, " ").trim();
  if (oneLine) {
    const shown = sanitizeDisplayText(oneLine, Infinity) ?? "";
    const length = [...shown].length;
    if (length > STATUS_TEXT_MAX) throw fail("text", `is up to ${STATUS_TEXT_MAX} characters, not ${length} characters`);
    if (!shown) throw fail("text", "needs a character that shows");
    const text = sanitizeStatusText(oneLine);
    if (!text) throw fail("text", "is plain text: no link or markup");
    status.text = text;
  }
  if (!status.text && !status.emoji && !status.availability) {
    throw new CliError(code, `Nothing to set: give a ${name("text")}, ${name("emoji")} or ${name("availability")}`);
  }
  if (input.until !== undefined) {
    if (!Number.isSafeInteger(input.until) || input.until <= now) throw fail("until", "is a time to come: a status that ended is none");
    // As the command line's --until, so the socket cannot keep an end past the last time a Date holds.
    if (input.until > now + STATUS_CARD_LIMITS.nextRunMs) throw fail("until", "is a time within a year from now");
    status.until = input.until;
  }
  return status;
}

/** What `status set|clear|show` answer: the status with every field (null when not set), or null when there is none. */
export function statusJson(status: PersonStatus | undefined): { status: { text: string | null; emoji: string | null; availability: StatusAvailability | null; until: number | null } | null } {
  return { status: status ? { text: status.text ?? null, emoji: status.emoji ?? null, availability: status.availability ?? null, until: status.until ?? null } : null };
}

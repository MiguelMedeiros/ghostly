/**
 * Display text a peer chooses: nicknames and service names. It is shown next
 * to the peer's messages and in the chat header, so it must not be able to
 * read as something it is not, and it must not be able to grow without bound.
 */

/** Longest nickname kept from a peer. The `hello` frame has always cut here. */
export const MAX_NICK_LENGTH = 64;

/**
 * Invisible and direction-changing characters. Unlike a file name, display
 * text may legitimately hold emoji and Indic or Arabic joiners, so the two
 * joiners stay and the rest of Cf goes: bidi overrides and isolates reorder
 * what follows them, and the others hide text or let two different names
 * render identically.
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
/** Zero-width non-joiner and zero-width joiner. */
const KEEP = /[\u200c\u200d]/;

/** `text` without its invisible and direction-changing characters, at any length: for display text with a cut of its own. */
export function stripHidden(text: string): string {
  return text.replace(HIDDEN, (char) => (KEEP.test(char) ? char : ""));
}

/**
 * What draws nothing when it stands alone and `HIDDEN` leaves in, since text needs it beside something else: the
 * joiners, the fillers, the variation selectors and the other default-ignorable code points, combining marks, white
 * space and the blank Braille pattern.
 */
const UNSEEN = /^[\p{Default_Ignorable_Code_Point}\p{M}\p{White_Space}\u2800]*$/u;

/** Whether `text` holds a character that shows by itself: a name of joiners, fillers or marks alone has none. */
export function hasVisible(text: string): boolean {
  return !UNSEEN.test(text);
}

/** Undefined when nothing visible is left, so callers can fall back. */
export function sanitizeDisplayText(text: string, max: number): string | undefined {
  const clean = [...stripHidden(text)].slice(0, max).join("").trim();
  return hasVisible(clean) ? clean : undefined;
}

/** A nickname as it arrived from a peer, ready to show. */
export function sanitizeNick(nick: unknown): string | undefined {
  return typeof nick === "string" ? sanitizeDisplayText(nick, MAX_NICK_LENGTH) : undefined;
}

/**
 * `text` without the characters of `chars` it ends with, in one pass from the end. A `/[…]+$/` replace would retry
 * from every character of a run that does not reach the end.
 */
export function trimEndOf(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1])) end--;
  return end === text.length ? text : text.slice(0, end);
}

/** What a token is copied with before it: quotes, guillemets, brackets, a backtick. */
const PASTE_OPENERS = "\"'“‘«‹<[({`";
/** What a token is copied with after it: those closed, and a sentence's marks. */
const PASTE_CLOSERS = "\"'”’»›>])}`.,!?;:…";
const PASTE_SPACES = " \t\n\r\u00a0\u202f";

/**
 * The token in what someone copied with the words around it: an invite, a group's link or a device code from the end
 * of "Join us: <https://…#ghostly1…>!", "« ghostly1… »" or "code: ghostly1…". The last word, without the quotes,
 * brackets and marks before and after it. Readers try it only once the paste itself did not read, so a bare token
 * reads as it always did and a token with a character lost is still refused as one.
 */
export function unwrapPasted(text: string): string {
  const words = trimEndOf(text.trim(), PASTE_CLOSERS + PASTE_SPACES).split(/\s+/);
  const last = words[words.length - 1] ?? "";
  let start = 0;
  while (start < last.length && PASTE_OPENERS.includes(last[start])) start++;
  return trimEndOf(last.slice(start), PASTE_CLOSERS);
}

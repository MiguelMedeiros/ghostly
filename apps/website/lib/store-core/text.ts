// Copied from packages/core/src/text.ts by apps/website/scripts/sync-store-core.mjs. Edit core's file, then run npm run sync:store-core.
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

/** The variation selectors other than VS15 and VS16: a symbol's, an ideograph's, a Mongolian letter's. */
const SELECTOR = /[︀-︍᠋-᠍᠏\u{e0100}-\u{e01ef}]/u;
/** Letters of the alphabets that neither join their letters nor make conjuncts: a joiner beside one changes nothing. */
const NO_JOINING = /[\p{sc=Latin}\p{sc=Greek}\p{sc=Cyrillic}\p{sc=Armenian}\p{sc=Georgian}\p{sc=Hebrew}\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}\p{sc=Thai}\p{sc=Lao}\p{sc=Ethiopic}]/u;
const EUROPEAN = /[\p{sc=Latin}\p{sc=Greek}\p{sc=Cyrillic}]/u;
const LETTER = /\p{L}/u, MARK = /\p{M}/u, SYMBOL = /\p{S}/u;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
/** What an emoji sequence's joiner follows: a pictograph, a skin tone, or VS16 after a pictograph. */
const BEFORE_EMOJI_JOINER = /[\p{Extended_Pictographic}\p{Emoji_Modifier}️]/u;
const EMOJI = /\p{Emoji}/u, ASCII = /^[\0-\x7f]$/, KEYCAP_BASE = /^[#*0-9]$/;
const joining = (char: string) => LETTER.test(char) && !NO_JOINING.test(char);

/**
 * `text` without the joiners and variation selectors that join or select nothing, which draw nothing and could only
 * make a name look like another one, or one nobody can type. A zero-width joiner stays between two emoji (a skin tone
 * or VS16 before it) and either joiner between two letters of a script that joins its letters or makes conjuncts
 * (Persian, the Indic scripts; the marks after the first letter, a virama, don't count); VS15 and VS16 stay after an
 * emoji (an ASCII one only in a keycap), and the other selectors after a symbol or a letter that is not Latin, Greek or
 * Cyrillic.
 */
export function dropLoneJoiners(text: string): string {
  const chars = Array.from(text);
  let out = "", last = "", base = "";
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i], next = chars[i + 1] ?? "";
    let keep = true;
    if (char === "‍" || char === "‌") keep = (char === "‍" && BEFORE_EMOJI_JOINER.test(last) && PICTOGRAPH.test(next)) || (joining(base) && joining(next));
    else if (char === "︎" || char === "️") keep = (EMOJI.test(last) && !ASCII.test(last)) || (KEYCAP_BASE.test(last) && next === "⃣");
    else if (SELECTOR.test(char)) keep = SYMBOL.test(last) || (LETTER.test(last) && !EUROPEAN.test(last));
    if (!keep) continue;
    out += char;
    last = char;
    if (!MARK.test(char)) base = char;
  }
  return out;
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

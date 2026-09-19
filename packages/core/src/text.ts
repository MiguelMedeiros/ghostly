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

/** Undefined when nothing visible is left, so callers can fall back. */
export function sanitizeDisplayText(text: string, max: number): string | undefined {
  const visible = text.replace(HIDDEN, (char) => (KEEP.test(char) ? char : ""));
  const clean = [...visible].slice(0, max).join("").trim();
  return clean || undefined;
}

/** A nickname as it arrived from a peer, ready to show. */
export function sanitizeNick(nick: unknown): string | undefined {
  return typeof nick === "string" ? sanitizeDisplayText(nick, MAX_NICK_LENGTH) : undefined;
}

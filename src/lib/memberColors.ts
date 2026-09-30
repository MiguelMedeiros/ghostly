/*
 * A group member's colour (WhatsApp and Telegram do the same): their name above their messages, in a quote of theirs,
 * in a mention of them and in the typing line all take one hue, so who wrote what reads at a glance.
 *
 * The hues are given out over the group's roster (`rosterColors`), so up to twelve members never share one; past
 * twelve they come round again. The roster is the group's own, the same on every member's device (the chain keeps it
 * sorted by key), so every member sees the same colours. A member keeps the hue their key points to unless someone
 * earlier in the roster took it first: a colour changes only when a member who comes or goes was in its way. Someone
 * no longer in the roster (a removed member's old messages) goes by their key's hue alone.
 *
 * The hues are theme tokens (`--color-member-N` in index.css), each at least 4.5:1 on every bubble and header of
 * every theme (src/test/groups/memberColors.test.ts measures them).
 */

/** Written out in full: Tailwind makes only the classes it finds in the source. */
export const MEMBER_TEXT = [
  "text-member-0", "text-member-1", "text-member-2", "text-member-3", "text-member-4", "text-member-5",
  "text-member-6", "text-member-7", "text-member-8", "text-member-9", "text-member-10", "text-member-11",
] as const;

const HUES = MEMBER_TEXT.length;

/** The hue a member's key points to: FNV-1a of the key, so nothing but the key decides it. */
export function memberColorIndex(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619) >>> 0;
  // Mixed once more: FNV's low bits follow the last characters closely, and keys may end alike.
  hash = Math.imul(hash ^ (hash >>> 15), 2246822507) >>> 0;
  return ((hash ^ (hash >>> 13)) >>> 0) % HUES;
}

/**
 * Each member's hue in a group: in the order of their keys, each takes the hue their key points to, or the next one
 * free. Twelve given out, all are free again for the next twelve. The same roster gives the same hues, in any order.
 */
export function rosterColors(keys: readonly string[]): Map<string, number> {
  const colors = new Map<string, number>();
  let taken = new Set<number>();
  for (const key of [...new Set(keys)].sort()) {
    if (taken.size === HUES) taken = new Set();
    let hue = memberColorIndex(key);
    while (taken.has(hue)) hue = (hue + 1) % HUES;
    taken.add(hue);
    colors.set(key, hue);
  }
  return colors;
}

/** The text class of a member's colour: from the group's hues when given, else from their key alone. */
export const memberText = (key: string, colors?: ReadonlyMap<string, number>): string => MEMBER_TEXT[colors?.get(key) ?? memberColorIndex(key)];

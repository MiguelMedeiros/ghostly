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
 * How far along the palette a member looks when the hue their key points to will not do: five of twelve, so the next
 * one tried is far from it, and every hue is tried (5 and 12 share no factor).
 */
const STEP = 5;

/** How many hues apart two members of a group this big are kept: the palette's neighbours look alike. */
export const spacingFor = (members: number): number => members <= 4 ? 3 : members <= 6 ? 2 : 1;

/** Steps between two hues around the palette. */
const apart = (a: number, b: number) => { const d = Math.abs(a - b) % HUES; return Math.min(d, HUES - d); };

/**
 * Each member's hue in a group: in the order of their keys, each takes the hue their key points to if it is at least
 * `spacingFor` hues from the ones given out already, else the first such one `STEP` at a time from there; with none
 * that far left, the one farthest from the others. So no two members of up to twelve share a hue, and in a small
 * group they are far apart. Twelve given out, all are free again for the next twelve. The same roster gives the same
 * hues, in any order.
 */
export function rosterColors(keys: readonly string[]): Map<string, number> {
  const roster = [...new Set(keys)].sort();
  const spacing = spacingFor(roster.length);
  const colors = new Map<string, number>();
  let taken: number[] = [];
  for (const key of roster) {
    if (taken.length === HUES) taken = [];
    const tries = Array.from({ length: HUES }, (_, i) => (memberColorIndex(key) + i * STEP) % HUES).filter(h => !taken.includes(h));
    const room = (h: number) => taken.length ? Math.min(...taken.map(t => apart(h, t))) : HUES;
    const hue = tries.find(h => room(h) >= spacing) ?? tries.reduce((best, h) => room(h) > room(best) ? h : best);
    taken.push(hue);
    colors.set(key, hue);
  }
  return colors;
}

/** The text class of a member's colour: from the group's hues when given, else from their key alone. */
export const memberText = (key: string, colors?: ReadonlyMap<string, number>): string => MEMBER_TEXT[colors?.get(key) ?? memberColorIndex(key)];

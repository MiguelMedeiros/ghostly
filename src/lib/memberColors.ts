/*
 * A group member's colour (WhatsApp and Telegram do the same): their name above their messages, in a quote of theirs,
 * in a mention of them and in the typing line all take one hue, so who wrote what reads at a glance. It comes from the
 * member's key alone: the same member has the same colour on every device, after every reload, whatever their name.
 * The hues are theme tokens (`--color-member-N` in index.css), each at least 4.5:1 on every bubble and header of
 * every theme (src/test/groups/memberColors.test.ts measures them).
 */

/** Written out in full: Tailwind makes only the classes it finds in the source. */
export const MEMBER_TEXT = [
  "text-member-0", "text-member-1", "text-member-2", "text-member-3", "text-member-4", "text-member-5",
  "text-member-6", "text-member-7", "text-member-8", "text-member-9", "text-member-10", "text-member-11",
] as const;

/** Where a member's key falls in the palette: FNV-1a of the key, so nothing but the key decides it. */
export function memberColorIndex(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619) >>> 0;
  // Mixed once more: FNV's low bits follow the last characters closely, and keys may end alike.
  hash = Math.imul(hash ^ (hash >>> 15), 2246822507) >>> 0;
  return ((hash ^ (hash >>> 13)) >>> 0) % MEMBER_TEXT.length;
}

/** The text class of a member's colour. */
export const memberText = (key: string): string => MEMBER_TEXT[memberColorIndex(key)];

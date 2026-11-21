/**
 * Settings → Text size: how large the chat's words are on this device (messages, quotes, link previews, the chat's
 * system lines and days, the message field, the chat list's names and previews). Icons, headers and tabs keep their
 * size. Kept with this profile's settings on this device, never sent anywhere.
 */
export const TEXT_SIZES = ["small", "default", "large", "larger", "huge"] as const;
export type TextSize = (typeof TEXT_SIZES)[number];

/** Each step's share of the default size: `--chat-text-scale` in index.css. */
export const TEXT_SCALE: Readonly<Record<TextSize, number>> = { small: 0.9, default: 1, large: 1.15, larger: 1.3, huge: 1.5 };

/** A stored value as a step: anything else (an older copy, a hand edit) is the default. */
export function textSizeOf(value: unknown): TextSize {
  return TEXT_SIZES.includes(value as TextSize) ? (value as TextSize) : "default";
}

/** Sets the chat's text to `size` on the page, as the CSS variable every chat text size is multiplied by. */
export function applyTextSize(size: TextSize, root: HTMLElement = document.documentElement): void {
  root.style.setProperty("--chat-text-scale", String(TEXT_SCALE[size]));
}

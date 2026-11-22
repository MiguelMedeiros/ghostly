/** `text` as a literal piece of a RegExp: every character a pattern gives a meaning to, backslash included, escaped. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

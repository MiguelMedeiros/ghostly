import { MAX_NICK_LENGTH, hasVisible, stripHidden } from "@ghostly/core";
import { fitText, splitGraphemes } from "./fitText";

/** Longest name in chats a person gives themselves, in characters as seen (graphemes): an emoji family is one. */
export const OWN_NAME_LENGTH = 20;

/**
 * Whether a name in chats fits whole: `OWN_NAME_LENGTH` characters, and no more code points than a contact keeps
 * (`MAX_NICK_LENGTH`), so neither side cuts it inside an emoji. An input's `maxLength` counts UTF-16 units: 10 emoji
 * filled it and a pasted family lost its last person, leaving a dangling joiner.
 */
export const fitsOwnName = (s: string) => [...s].length <= MAX_NICK_LENGTH && splitGraphemes(s).length <= OWN_NAME_LENGTH;

/**
 * The person's own name in chats as it is kept and sent: what a contact applies to it (`sanitizeNick`), hidden and
 * direction-changing characters gone, spaces collapsed and trimmed, cut between whole characters. Empty when nothing
 * visible is left (a name of zero-width spaces), so it reads as no name: Anonymous here, "Contact" there.
 */
export function cleanOwnName(value: string): string {
  const clean = fitText(stripHidden(value).replace(/\s+/g, " ").trim(), fitsOwnName).trim();
  return hasVisible(clean) ? clean : "";
}

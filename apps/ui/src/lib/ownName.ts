import { MAX_NICK_LENGTH, hasVisible, stripHidden } from "@ghostly/core";
import { fitText } from "./fitText";

/**
 * Longest name in chats a person gives themselves, in characters (code points): as many as a contact keeps
 * (`MAX_NICK_LENGTH`, WISP 401), on every version since 1.0. A name of 20 was cut short of what contacts take.
 */
export const OWN_NAME_LENGTH = MAX_NICK_LENGTH;

/**
 * Whether a name in chats fits whole: no more code points than a contact keeps, so neither side cuts it, and a field
 * cuts it only between whole characters (`fitText`), never inside an emoji. An input's `maxLength` counts UTF-16
 * units: it filled with half as many emoji and a pasted family lost its last person, leaving a dangling joiner.
 */
export const fitsOwnName = (s: string) => [...s].length <= OWN_NAME_LENGTH;

/**
 * The person's own name in chats as it is kept and sent: what a contact applies to it (`sanitizeNick`), hidden and
 * direction-changing characters gone, spaces collapsed and trimmed, cut between whole characters. Empty when nothing
 * visible is left (a name of zero-width spaces), so it reads as no name: Anonymous here, "Contact" there.
 */
export function cleanOwnName(value: string): string {
  const clean = fitText(stripHidden(value).replace(/\s+/g, " ").trim(), fitsOwnName).trim();
  return hasVisible(clean) ? clean : "";
}

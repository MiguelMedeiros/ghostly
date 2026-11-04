/**
 * The "Last updated" dates of the privacy policy (page.tsx), and the text they date.
 *
 * Changing what page.tsx says? Set the date of that change here, then the hash: scripts/privacy-date.test.mjs fails
 * while PRIVACY_TEXT_SHA is not the SHA-256 of page.tsx (whitespace folded), and its failure prints the new value. A
 * change to code alone (a class name, an import) needs only the new hash.
 */

/** Shown until the released Ghostly has Apps: the last change to any line but the `{apps && ...}` items. */
export const LAST_UPDATED = "November 3, 2026";
/** Shown once Apps are released: the last change to any line, the Apps items included. */
export const LAST_UPDATED_APPS = "November 3, 2026";
/** page.tsx as these dates describe it (scripts/privacy-date.test.mjs). */
export const PRIVACY_TEXT_SHA = "9d1338f6f43d750019bcde7f66fb5d5781a25c604f97c1583c0be3972b435424";

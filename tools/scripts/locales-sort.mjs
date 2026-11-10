#!/usr/bin/env node
// Sorts the keys of every locale file, apps/ui/src/locales/<language>/<area>.json, at every level (2-space JSON, one key per
// line). Pull requests that add keys to the same area then add lines at different places instead of all appending
// to the end, and do not conflict. The i18n tests fail on a file out of order (apps/ui/src/test/i18n/keys.test.ts).
//
//   npm run locales:sort
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LOCALES = join(fileURLToPath(import.meta.url), "..", "..", "..", "apps", "ui", "src", "locales");

/** The value with every object's keys in order (plain code-unit order, as `Array.prototype.sort` gives). */
export function sortKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

/**
 * The characters that change the direction text is drawn in (Arabic letter mark, left-to-right and right-to-left
 * marks, embeddings, overrides and isolates). Invisible, so they are written escaped (`\u2066`), never raw: a reviewer
 * then sees where a string's direction changes.
 */
const DIRECTION_MARKS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const escaped = (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;

/** A locale file's text as it must be written. */
export const formatLocale = (text) => `${JSON.stringify(sortKeys(JSON.parse(text)), null, 2).replace(DIRECTION_MARKS, escaped)}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let changed = 0;
  for (const language of readdirSync(LOCALES, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const file of readdirSync(join(LOCALES, language.name)).filter((f) => f.endsWith(".json"))) {
      const path = join(LOCALES, language.name, file);
      const text = readFileSync(path, "utf8");
      const sorted = formatLocale(text);
      if (sorted !== text) { writeFileSync(path, sorted); changed++; console.log(`sorted apps/ui/src/locales/${language.name}/${file}`); }
    }
  }
  console.log(changed ? `${changed} locale files sorted` : "every locale file is in order");
}

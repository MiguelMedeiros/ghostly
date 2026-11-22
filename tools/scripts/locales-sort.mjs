#!/usr/bin/env node
// Sorts the keys of every locale file, apps/ui/src/locales/<language>/<area>.json, at every level (2-space JSON, one key per
// line). Pull requests that add keys to the same area then add lines at different places instead of all appending
// to the end, and do not conflict.
//
//   npm run locales:sort               # sorts the files in place
//   npm run locales:sort -- --check    # writes nothing: fails on a file out of order or a word the app does not use
//                                      # (CI's lint job), naming the file and the key
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

/**
 * The app's Portuguese is Brazilian (`pt` is served as `pt-BR`, lib/documentLanguage.ts): "você", "contato",
 * "conexão", "arquivo". A European form ("a tentar", "ligação", "ficheiro") next to them reads as two languages
 * in one scene.
 */
const EUROPEAN_PORTUGUESE = [
  ["a + infinitive for an ongoing action", /\b(?:está|estão|estou|continua|continuam|fica|ficam|anda|andam) a \p{L}+(?:ar|er|ir)\b|(?:^|[^\p{L}])a tentar\b/iu],
  ["ligação for a connection", /\bligaç(?:ão|ões)\b/iu],
  ["partilhar for share", /(?:^|[^\p{L}])partilh/iu],
  ["vosso/vossa", /\bvoss[oa]s?\b/iu],
  ["contacto", /\bcontactos?\b/iu],
  ["ficheiro", /\bficheiros?\b/iu],
];

/**
 * A device on standby is ready, not pending. Arabic names that state "وضع الاستعداد" everywhere: the devices list,
 * the standby screen, Add a device and the profile switcher. "انتظار" is kept for lines that really wait on
 * something ("في انتظار جهازك الآخر…"); a row reading "في الانتظار" looks like it is still waiting.
 */
const STANDBY_KEYS = ["devices.section.standby", "devices.section.thisStandby", "devices.add.done", "devices.standby.hint.standby", "profileSwitcher.standby"];

/** `[file, key, text]` for every string of a language's files: `file` is `<language>/<area>.json`, `key` `<area>.<path>`. */
function strings(dir, language) {
  const walk = (value, file, key) => {
    if (typeof value === "string") return [[file, key, value]];
    if (value && typeof value === "object") return Object.entries(value).flatMap(([k, inner]) => walk(inner, file, `${key}.${k}`));
    return [];
  };
  return readdirSync(join(dir, language)).filter((f) => f.endsWith(".json")).sort()
    .flatMap((f) => walk(JSON.parse(readFileSync(join(dir, language, f), "utf8")), `${language}/${f}`, f.slice(0, -".json".length)));
}

/** The first key (`<area>.<path>`) written before one it should follow ("common.zzz before anonymous"), or undefined. */
function unsortedKey(value, key) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  const at = keys.findIndex((k, i) => i > 0 && k < keys[i - 1]);
  if (at > 0) return `${key}.${keys[at - 1]} before ${keys[at]}`;
  for (const k of keys) {
    const inner = unsortedKey(value[k], `${key}.${k}`);
    if (inner) return inner;
  }
  return undefined;
}

/** What `--check` fails on, one line each (`<language>/<area>.json: <key>: <why>`), in the locale folder `dir`. */
export function checkLocales(dir = LOCALES) {
  const problems = [];
  for (const language of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    for (const file of readdirSync(join(dir, language)).filter((f) => f.endsWith(".json")).sort()) {
      const text = readFileSync(join(dir, language, file), "utf8");
      if (formatLocale(text) === text) continue;
      const key = unsortedKey(JSON.parse(text), file.slice(0, -".json".length));
      // Sorted but written otherwise: another indent, a raw direction mark, no newline at the end.
      const line = formatLocale(text).split("\n").findIndex((l, i) => l !== text.split("\n")[i]) + 1;
      problems.push(key ? `${language}/${file}: ${key}: out of order (npm run locales:sort)` : `${language}/${file}:${line}: not written as npm run locales:sort writes it`);
    }
  }

  const portuguese = strings(dir, "pt");
  // A folder or a reader that found nothing would make the checks below pass on nothing.
  if (portuguese.length < 1000) problems.push(`pt: ${portuguese.length} strings read, not the app's (over 1000)`);
  for (const [file, key, text] of portuguese) {
    for (const [name, form] of EUROPEAN_PORTUGUESE) {
      if (form.test(text)) problems.push(`${file}: ${key}: European Portuguese (${name}), the app's is Brazilian: ${text}`);
    }
  }

  const english = new Map(strings(dir, "en").map(([, key, text]) => [key, text]));
  const arabic = new Map(strings(dir, "ar").map(([file, key, text]) => [key, [file, text]]));
  const standby = [...english].filter(([, text]) => /\bstandby\b/i.test(text)).map(([key]) => key);
  for (const key of STANDBY_KEYS.filter((k) => !standby.includes(k))) problems.push(`en: ${key}: no longer says standby (locales-sort.mjs STANDBY_KEYS)`);
  for (const key of standby) {
    const [file, text] = arabic.get(key) ?? [`ar/${key.split(".")[0]}.json`, ""];
    if (!text.includes("الاستعداد") || text.includes("انتظار")) problems.push(`${file}: ${key}: says standby as وضع الاستعداد, never انتظار: ${text}`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && args[0] !== "--check")) {
    console.error("usage: npm run locales:sort [-- --check] (without --check: it sorts the files in place)");
    process.exit(2);
  }
  if (args[0] === "--check") {
    const problems = checkLocales();
    for (const problem of problems) console.error(`apps/ui/src/locales/${problem}`);
    if (problems.length) {
      console.error(`${problems.length} locale problem(s)`);
      process.exit(1);
    }
    console.log("every locale file is in order");
    process.exit(0);
  }
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

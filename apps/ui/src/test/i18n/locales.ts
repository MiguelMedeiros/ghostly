import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Language } from "../../lib/settings";
import { locales } from "../../locales";

/** Every locale the app ships, as `I18nContext` loads them. */
export const LOCALES: Record<Language, unknown> = locales;
export const LANGUAGES = Object.keys(LOCALES) as Language[];

/** A locale flattened to `section.key` → value, the way `t()` looks keys up. Values are left as they are, strings or not. */
export function flatten(dict: unknown, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, value] of Object.entries(dict as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) flatten(value, path).forEach((v, k) => out.set(k, v));
    else out.set(path, value);
  }
  return out;
}

/**
 * Each locale flattened once. `lookup` runs once per key per language (thousands of times in keys.test.ts), and
 * flattening the whole locale on every call made those tests quadratic: 3-5 s each, past the 5 s timeout under load.
 */
const flattened = new Map<Language, Map<string, unknown>>();

/** What `t()` would find for `key` in `language`: the string, or undefined where it would show the raw key. */
export function lookup(language: Language, key: string): string | undefined {
  let map = flattened.get(language);
  if (!map) flattened.set(language, (map = flatten(LOCALES[language])));
  const value = map.get(key);
  return typeof value === "string" ? value : undefined;
}

/** The keys a source file passes to `t()` as a literal. Keys built at run time (`t(option.labelKey)`) are not seen. */
export function literalKeys(source: string): string[] {
  return [...new Set([...source.matchAll(/\bt\(\s*(["'])([^"'`]+)\1/g)].map((m) => m[2]))];
}

/** The top-level sections of en.json (`common`, `chat`...): a DOM string starting with one of them looks like a raw key. */
export const SECTIONS = Object.keys(locales.en);

const SRC = join(fileURLToPath(import.meta.url), "../../..");

/**
 * The app's sources (apps/ui/src/, without the tests), read from disk and keyed as `../../components/X.tsx`. Read as files,
 * not imported with `?raw`: an import would make coverage count each of them as loaded, and empty.
 */
export function appSources(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (path !== join(SRC, "test")) walk(path); }
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out[`../../${relative(SRC, path)}`] = readFileSync(path, "utf8");
    }
  };
  walk(SRC);
  return out;
}

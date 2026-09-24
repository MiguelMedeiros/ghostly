import type { Language } from "../../lib/settings";
import en from "../../locales/en.json";
import pt from "../../locales/pt.json";
import es from "../../locales/es.json";
import fr from "../../locales/fr.json";
import it from "../../locales/it.json";
import zh from "../../locales/zh.json";
import ja from "../../locales/ja.json";
import ar from "../../locales/ar.json";

/** Every locale the app ships, as `I18nContext` loads them. */
export const LOCALES: Record<Language, unknown> = { en, pt, es, fr, it, zh, ja, ar };
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

/** What `t()` would find for `key` in `language`: the string, or undefined where it would show the raw key. */
export function lookup(language: Language, key: string): string | undefined {
  const value = flatten(LOCALES[language]).get(key);
  return typeof value === "string" ? value : undefined;
}

/** The keys a source file passes to `t()` as a literal. Keys built at run time (`t(option.labelKey)`) are not seen. */
export function literalKeys(source: string): string[] {
  return [...new Set([...source.matchAll(/\bt\(\s*(["'])([^"'`]+)\1/g)].map((m) => m[2]))];
}

/** The top-level sections of en.json (`common`, `chat`...): a DOM string starting with one of them looks like a raw key. */
export const SECTIONS = Object.keys(en);

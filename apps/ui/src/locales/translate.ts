import en from "./en";
import type { Language } from "../lib/settings";

/** What `t()` looks up: an area and the path to a string in it, "chat.message.edit". */
type NestedKeyOf<T, K extends string = ""> = T extends object
  ? { [P in keyof T & string]: NestedKeyOf<T[P], K extends "" ? P : `${K}.${P}`> }[keyof T & string]
  : K;

export type TranslationKey = NestedKeyOf<typeof en>;

/**
 * `t()` as a value: for content worked out outside a component (identities/idCard.ts, lib/transportEvents.ts). It
 * knows its language, so a helper handed only `t` writes amounts in it too (lib/amount.ts).
 */
export type Translate = ((key: TranslationKey, params?: Record<string, string | number>) => string) & { readonly language?: Language };

function getNestedValue(obj: unknown, path: string): string {
  let current: unknown = obj;
  for (const key of path.split(".")) {
    if (current && typeof current === "object" && key in current) current = (current as Record<string, unknown>)[key];
    else return path;
  }
  return typeof current === "string" ? current : path;
}

/** The plural categories a language's dictionary may give a counted string under, as `<key>_<category>`. */
export const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"] as const;

const points = new Map<string, string>();
/** The decimal point `language` writes ("," in Portuguese, "." in English), worked out once per language. */
function decimalPoint(language: Language | undefined): string {
  const tag = language ?? "en";
  let point = points.get(tag);
  if (point === undefined) {
    try { point = new Intl.NumberFormat(tag).formatToParts(0.5).find((p) => p.type === "decimal")?.value ?? "."; } catch { point = "."; }
    points.set(tag, point);
  }
  return point;
}

/** A number as `formatAmount` writes it in `language` ("1,000", "1.000,5", "1 000", "-2"), or NaN for anything else. */
function writtenNumber(value: string | number, language: Language | undefined): number {
  if (typeof value === "number") return value;
  const text = value.trim().replace(/^[-\u2212]/, "");
  if (!/^\d[\d\s.,'\u00a0\u202f]*$/.test(text)) return NaN;
  const grouping = decimalPoint(language) === "," ? /[\s.'\u00a0\u202f]/g : /[\s,'\u00a0\u202f]/g;
  return (text.length < value.trim().length ? -1 : 1) * Number(text.replace(grouping, "").replace(",", "."));
}

/**
 * The plural category `count` takes in `language`. A language that says every count alike (Japanese, Chinese) has
 * forms only for a word it borrows, and borrowed it with its English number: "1 テスト sat", "2 テスト sats".
 */
function pluralCategory(count: number, language: Language | undefined): string | undefined {
  try { return pluralRules(language ?? "en").select(count); } catch { return undefined; }
}

/**
 * The rules `pluralCategory` reads for `language`, made once. Made at each string with a number, they were the page's
 * busiest code while nobody touched it: the chat list's look every few seconds says every row's time again.
 */
const PLURAL_RULES = new Map<string, Intl.PluralRules>();
function pluralRules(language: string): Intl.PluralRules {
  let rules = PLURAL_RULES.get(language);
  if (!rules) {
    const own = new Intl.PluralRules(language);
    rules = own.resolvedOptions().pluralCategories.length > 1 ? own : new Intl.PluralRules("en");
    PLURAL_RULES.set(language, rules);
  }
  return rules;
}

/**
 * The count a string is said for: its `count`, or its only number (`{{minutes}}`, an amount as written: "1.000" is a
 * thousand in Portuguese, not one). A string a language says otherwise
 * per count (Arabic's dual for 2, its singular after 11-99) has `<key>_<category>` beside it, picked by
 * Intl.PluralRules: one form for every count read "2 ملفات" and "32 ملفات" (agents#1614). Without such a key, the key.
 */
function pluralForm(dict: unknown, key: string, language: Language | undefined, params?: Record<string, string | number>): string | undefined {
  if (!params) return undefined;
  const numbers = Object.values(params).map((v) => writtenNumber(v, language)).filter(Number.isFinite);
  const count = "count" in params ? writtenNumber(params.count!, language) : numbers.length === 1 ? numbers[0]! : NaN;
  if (!Number.isFinite(count)) return undefined;
  const category = pluralCategory(count, language);
  if (!category) return undefined;
  const form = `${key}_${category}`;
  const value = getNestedValue(dict, form);
  return value === form ? undefined : value;
}

/**
 * The words an amount is counted in, handed to strings as `{{unit}}` (NetworkTag `satsIn`). Each has its forms per
 * count (`wallet.sats.testnet_one`: "test sat"), so "{{amount}} {{unit}}" reads "1 test sat" wherever it is said.
 */
const COUNTED_UNITS = ["wallet.sats.mainnet", "wallet.sats.testnet"] as const;

/**
 * `{{unit}}` said for the number written just before it in `text` (`{{fee}} {{unit}}`), or for `{{amount}}`: a counted
 * unit's own form for that count ("1 test sat", Arabic's dual), any other unit (USDT, a mint's own) as it is.
 */
function unitForm(dict: unknown, text: string, language: Language | undefined, params: Record<string, string | number>): string | undefined {
  const unit = params.unit;
  if (typeof unit !== "string") return undefined;
  const key = COUNTED_UNITS.find((k) => getNestedValue(dict, k) === unit);
  if (!key) return undefined;
  const before = /\{\{(\w+)\}\}\s*\{\{unit\}\}/.exec(text)?.[1];
  const value = before !== undefined && before in params ? params[before] : params.amount;
  if (value === undefined) return undefined;
  const count = writtenNumber(value, language);
  return Number.isFinite(count) ? pluralForm(dict, key, language, { count }) : undefined;
}

/**
 * Each `{{name}}` of `text` with its param as it is (a value that reads like another place stays so); a place with no
 * param stays for `fillNodes`. `unit`: `{{unit}}` said for its count.
 */
export function fillParams(text: string, params: Record<string, string | number>, unit?: string): string {
  return text.replace(/\{\{(\w+)\}\}/g, (place, k: string) => !Object.prototype.hasOwnProperty.call(params, k) ? place : String(k === "unit" && unit !== undefined ? unit : params[k]));
}

/** The translator for one language's dictionary: a key missing from it reads as the key itself. */
export function translateWith(dict: unknown, language?: Language): Translate {
  const t = (key: TranslationKey, params?: Record<string, string | number>) => {
    let value = pluralForm(dict, key, language, params) ?? getNestedValue(dict, key);
    if (params) {
      const unit = unitForm(dict, value, language, params);
      // Put in by a function: a string would read `$$`, `$&` and `` $` `` in a contact's name or text as patterns. In one
      // pass over the translation: one value after another filled a contact named "{{days}}" with the days after it.
      value = fillParams(value, params, unit);
    }
    return value;
  };
  return Object.assign(t, { language });
}

/** English, the source language: what the plain-text helpers say when no language is handed to them. */
export const englishT: Translate = translateWith(en, "en");

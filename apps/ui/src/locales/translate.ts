import en from "./en";

/** What `t()` looks up: an area and the path to a string in it, "chat.message.edit". */
type NestedKeyOf<T, K extends string = ""> = T extends object
  ? { [P in keyof T & string]: NestedKeyOf<T[P], K extends "" ? P : `${K}.${P}`> }[keyof T & string]
  : K;

export type TranslationKey = NestedKeyOf<typeof en>;

/** `t()` as a value: for content worked out outside a component (identities/idCard.ts, lib/transportEvents.ts). */
export type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

function getNestedValue(obj: unknown, path: string): string {
  let current: unknown = obj;
  for (const key of path.split(".")) {
    if (current && typeof current === "object" && key in current) current = (current as Record<string, unknown>)[key];
    else return path;
  }
  return typeof current === "string" ? current : path;
}

/** The translator for one language's dictionary: a key missing from it reads as the key itself. */
export function translateWith(dict: unknown): Translate {
  return (key, params) => {
    let value = getNestedValue(dict, key);
    if (params) {
      for (const [k, v] of Object.entries(params)) value = value.replace(new RegExp(`{{${k}}}`, "g"), String(v));
    }
    return value;
  };
}

/** English, the source language: what the plain-text helpers say when no language is handed to them. */
export const englishT: Translate = translateWith(en);

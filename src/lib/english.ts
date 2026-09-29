import en from "../locales/en";
import type { Translate } from "../contexts/I18nContext";

/**
 * `t()` in English, as I18nContext's would be with English chosen: the default of helpers that also run outside the
 * app's provider (a card worked out in a test, a label in a module that is not a component). A missing key shows
 * itself, as it does in the app.
 */
export const english: Translate = (key, params) => {
  let value: unknown = en;
  for (const part of key.split(".")) value = value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
  let text = typeof value === "string" ? value : key;
  if (params) for (const [k, v] of Object.entries(params)) text = text.replace(new RegExp(`{{${k}}}`, "g"), String(v));
  return text;
};

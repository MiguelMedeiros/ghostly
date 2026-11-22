import type { ProviderDescriptorView, ProviderField } from "@ghostly/browser/engine/paymentAdapters/providers/types";
import type { Translate, TranslationKey } from "../../../locales/translate";

/**
 * A provider's lines in the person's language: the built-in providers' description and their fields' label, help,
 * placeholder, options and suggestions are under `wallet.source.providers.<id>` (a field's under `fields.<name>`, an
 * option's or a suggestion's by its value). A line without a key (a plugin provider, a technical name like
 * "Macaroon (hex)") stays the descriptor's English. A command the English names (`lncli …`, `lightning-cli …`) is
 * kept as it is, as `{{command}}`.
 */
export function providerText<D extends Pick<ProviderDescriptorView, "id" | "description" | "fields">>(t: Translate, descriptor: D): D {
  const base = `wallet.source.providers.${descriptor.id}`;
  return { ...descriptor, description: said(t, `${base}.description`, descriptor.description), fields: descriptor.fields.map((f) => fieldText(t, descriptor.id, f)) };
}

/** One field of provider `id` in the person's language (see `providerText`). */
export function fieldText(t: Translate, id: string, field: ProviderField): ProviderField {
  const base = `wallet.source.providers.${id}.fields.${field.name}`;
  return {
    ...field,
    label: said(t, `${base}.label`, field.label),
    ...(field.help !== undefined && { help: said(t, `${base}.help`, field.help) }),
    ...(field.placeholder !== undefined && { placeholder: said(t, `${base}.placeholder`, field.placeholder) }),
    ...(field.options && { options: field.options.map((o) => ({ ...o, label: said(t, `${base}.options.${valueKey(o.value)}`, o.label) })) }),
    ...(field.suggestions && { suggestions: field.suggestions.map((s) => ({ ...s, label: said(t, `${base}.suggestions.${valueKey(s.value)}`, s.label) })) }),
  };
}

/** A value as a key: a URL's dots and slashes would read as nesting ("http://127.0.0.1:47002" → "http_127_0_0_1_47002"). */
const valueKey = (value: string) => value.replace(/[^A-Za-z0-9]+/g, "_");

/** The command an English line names, kept as it is in every language. */
const COMMAND = /\b(?:lncli|lightning-cli) [^()]*?(?=\s\(|$)/;

/** `key` in the person's language, or `english` where there is no such key (or its `{{command}}` is not in the English). */
function said(t: Translate, key: string, english: string): string {
  const command = COMMAND.exec(english)?.[0];
  const text = t(key as TranslationKey, command ? { command } : undefined);
  return text === key || text.includes("{{command}}") ? english : text;
}

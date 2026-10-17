import { describe, expect, it } from "vitest";

// covers: app.i18n

/*
 * The app's Portuguese is Brazilian (`pt` is served as `pt-BR`, lib/documentLanguage.ts): "você", "contato",
 * "conexão", "arquivo". A European form ("a tentar", "ligação", "ficheiro") next to them reads as two languages
 * in one scene.
 */

const files = import.meta.glob<Record<string, unknown>>("../../locales/pt/*.json", { eager: true, import: "default" });

const strings = (value: unknown, path: string): [string, string][] => {
  if (typeof value === "string") return [[path, value]];
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, inner]) => strings(inner, path ? `${path}.${key}` : key));
  return [];
};

const european: [string, RegExp][] = [
  ["a + infinitive for an ongoing action", /\b(?:está|estão|estou|continua|continuam|fica|ficam|anda|andam) a \p{L}+(?:ar|er|ir)\b|(?:^|[^\p{L}])a tentar\b/iu],
  ["ligação for a connection", /\bligaç(?:ão|ões)\b/iu],
  ["partilhar for share", /(?:^|[^\p{L}])partilh/iu],
  ["vosso/vossa", /\bvoss[oa]s?\b/iu],
  ["contacto", /\bcontactos?\b/iu],
  ["ficheiro", /\bficheiros?\b/iu],
];

const all = Object.entries(files).flatMap(([file, json]) => strings(json, file.replace(/^.*\/(\w+)\.json$/, "$1")));

describe("the Portuguese strings are Brazilian", () => {
  it("finds the strings to check", () => {
    expect(all.length).toBeGreaterThan(1000);
  });

  it.each(european)("no %s", (_, form) => {
    expect(all.filter(([, text]) => form.test(text)).map(([key, text]) => `${key}: ${text}`)).toEqual([]);
  });
});

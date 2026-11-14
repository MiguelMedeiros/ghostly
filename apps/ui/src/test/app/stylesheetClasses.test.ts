import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { appSources } from "../i18n/locales";

/**
 * A class a stylesheet styles that no source names anymore is a rule every app still ships, for nothing: what drew it
 * was removed or renamed, and the rule stayed (`.animate-pulse-dot` outlived the ringing card that pulsed with it).
 */

const SRC = join(fileURLToPath(import.meta.url), "../../..");
const stylesheets = (dir = SRC): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? (entry.name === "test" ? [] : stylesheets(join(dir, entry.name))) : entry.name.endsWith(".css") ? [join(dir, entry.name)] : []);

/** The classes a stylesheet's selectors name: comments, attribute values and declarations (`0.5s`) left out. */
function styledClasses(css: string): string[] {
  const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)].map(([, s]) => s.replace(/\[[^\]]*\]/g, ""));
  return [...new Set(selectors.flatMap(s => [...s.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map(([, name]) => name)))];
}

describe("the stylesheets' classes", () => {
  const sources = Object.values(appSources()).join("\n");
  const words = new Set(sources.match(/[\w-]+/g));
  // A name built in a template: `voice-${state}` names every `voice-…` class.
  const builtPrefixes = new Set([...sources.matchAll(/([\w-]+-)\$\{/g)].map(([, prefix]) => prefix));
  // deck/Deck.tsx names each part `${className}-${part}` too: `id-deck-marks` for an ID deck's `part('marks')`.
  const deckParts = new Set([...sources.matchAll(/\bpart\(['"]([\w-]+)['"]\)/g)].map(([, p]) => p));
  const deckClasses = new Set([...sources.matchAll(/\bclassName="([\w-]+-deck)"/g)].map(([, c]) => c));
  const named = (name: string) => {
    if (words.has(name)) return true;
    // highlight.js writes these into a code block's HTML itself (RichText's highlighted code).
    if (name.startsWith("hljs-")) return true;
    for (let at = name.indexOf("-"); at > 0; at = name.indexOf("-", at + 1)) {
      if (builtPrefixes.has(name.slice(0, at + 1))) return true;
      if (deckClasses.has(name.slice(0, at)) && deckParts.has(name.slice(at + 1))) return true;
    }
    return false;
  };

  it("finds the stylesheets and the classes in them", () => {
    // A walk or a pattern that found nothing would let the check below pass on nothing.
    const all = stylesheets().flatMap(file => styledClasses(readFileSync(file, "utf8")));
    expect(stylesheets().length).toBeGreaterThan(20);
    expect(all.length).toBeGreaterThan(500);
    expect(all).toEqual(expect.arrayContaining(["toast-place", "id-deck-marks", "hljs-keyword", "animate-ring-pulse"]));
    expect(named("id-deck-marks")).toBe(true);
    expect(named("toast-place-gone")).toBe(false);
  });

  it("are each named by a source: none is left from something removed", () => {
    const unnamed = stylesheets().flatMap(file =>
      styledClasses(readFileSync(file, "utf8")).filter(name => !named(name)).map(name => `${file.slice(SRC.length + 1)}: .${name}`));
    expect(unnamed).toEqual([]);
  });
});

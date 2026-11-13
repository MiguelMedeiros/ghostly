import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { API_METHODS } from "../src/api";
import { HELLO } from "../src/daemonProof";
// covers: headless.cli

/**
 * The socket methods the README's "Methods:" paragraph names: each backticked `a.b|c|d` spelled out as `a.b`, `a.c`,
 * `a.d` (a line break may fall inside the backticks). `engine.call`'s params example is no method.
 */
function documented(): string[] {
  const readme = readFileSync(resolve(import.meta.dirname, "../README.md"), "utf8");
  const paragraph = readme.slice(readme.indexOf("\nMethods: "), readme.indexOf("for anything else the app does"));
  return [...paragraph.matchAll(/`([^`]+)`/g)].map(([, span]) => span.replace(/\s+/g, "")).filter((span) => !span.startsWith("{")).flatMap((span) => {
    const [first, ...rest] = span.split("|");
    const prefix = first.slice(0, first.lastIndexOf(".") + 1);
    return [first, ...rest.map((name) => prefix + name)];
  });
}

/** The daemon answers the API's table and, in host.ts itself, `events.subscribe` and the hello. */
it("the README's socket methods are every method the daemon answers, and no other", () => {
  const answered = [...API_METHODS, "events.subscribe", HELLO];
  const named = documented();
  expect(named.length).toBeGreaterThan(100);
  expect(answered.filter((method) => !named.includes(method)).sort()).toEqual([]);
  expect(named.filter((method) => !answered.includes(method)).sort()).toEqual([]);
  expect(named.length).toBe(new Set(named).size);
});

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

/**
 * Every module of the shared UI (`apps/ui/src/`) is one an app loads. A module nothing imports any more still passes
 * typecheck, lint and its own tests, and stays in the tree for good: an old `Header` with a "Burn" button, hooks for
 * the first invite flow, and a re-export of core's WebRTC helpers outlived their last caller by months, and the test
 * map still sent changes to them through e2e features. Imports from tests do not count: a module only a test loads
 * ships in no app.
 */
const root = resolve(import.meta.dirname, "../../..");
const UI = "apps/ui/src";
/** Where an import of a UI module can come from: the UI itself, the clients that build it, and the packages. */
const IMPORTERS = ["apps/ui", "apps/web", "apps/extension", "packages"];

const isTest = (file: string) => /(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file);
const tracked = (...paths: string[]) =>
  execFileSync("git", ["ls-files", "--", ...paths], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);

/** A path as written in an import, to the tracked file Vite would load. */
function resolveFrom(from: string, specifier: string, files: Set<string>): string | undefined {
  const path = relative(root, resolve(dirname(join(root, from)), specifier.split("?")[0]));
  const bare = path.replace(/\.[cm]?jsx?$/, "");
  return [path, ...["", "/index"].flatMap((tail) => [".ts", ".tsx"].map((ext) => bare + tail + ext))].find((p) => files.has(p));
}

/** `import.meta.glob` patterns, `*` only (what the UI uses), with `!` exclusions. */
const globs = (text: string) =>
  [...text.matchAll(/import\.meta\.glob(?:<[^(]*>)?\(\s*(\[[^\]]*\]|["'][^"']+["'])/g)].map(([, arg]) =>
    [...arg.matchAll(/["']([^"']+)["']/g)].map(([, pattern]) => pattern),
  );
const globRegex = (from: string, pattern: string) =>
  new RegExp(`^${relative(root, resolve(dirname(join(root, from)), pattern)).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);

it("every module in apps/ui/src is imported by an app, not only by tests", () => {
  const files = new Set(tracked(...IMPORTERS).filter((f) => existsSync(join(root, f))));
  const modules = [...files].filter((f) => f.startsWith(`${UI}/`) && /\.tsx?$/.test(f) && !/\.d\.ts$/.test(f) && !isTest(f));
  const imported = new Set<string>();
  // The page each app's HTML starts from.
  for (const html of [...files].filter((f) => f.endsWith(".html"))) {
    for (const [, src] of readFileSync(join(root, html), "utf8").matchAll(/<script[^>]*\ssrc="\/([^"]+)"/g)) {
      const entry = resolveFrom(join(dirname(html), "x"), `./${src}`, files);
      if (entry) imported.add(entry);
    }
  }
  for (const file of [...files].filter((f) => /\.[cm]?[jt]sx?$/.test(f) && !isTest(f))) {
    const text = readFileSync(join(root, file), "utf8");
    const specifiers = [
      ...ts.preProcessFile(text, true, true).importedFiles.map(({ fileName }) => fileName),
      ...[...text.matchAll(/new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url/g)].map(([, s]) => s),
    ];
    for (const specifier of specifiers.filter((s) => s.startsWith("."))) {
      const target = resolveFrom(file, specifier, files);
      if (target && target !== file) imported.add(target);
    }
    for (const patterns of globs(text)) {
      const take = patterns.filter((p) => !p.startsWith("!")).map((p) => globRegex(file, p));
      const drop = patterns.filter((p) => p.startsWith("!")).map((p) => globRegex(file, p.slice(1)));
      for (const m of modules) if (take.some((r) => r.test(m)) && !drop.some((r) => r.test(m))) imported.add(m);
    }
  }
  expect(modules.length).toBeGreaterThan(500);
  expect(imported).toContain(`${UI}/main.tsx`);
  expect(modules.filter((m) => !imported.has(m))).toEqual([]);
});

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

// covers: extension.engine

const ROOT = resolve(__dirname, "../../..");

/** The modules a module imports when it loads: no `import type`, no `import()` (those are chunks of their own). */
function staticImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  return source.statements.flatMap((statement) => {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly) return [];
      const named = clause?.namedBindings;
      if (clause && !clause.name && named && ts.isNamedImports(named) && named.elements.every((element) => element.isTypeOnly)) return [];
      return [(statement.moduleSpecifier as ts.StringLiteral).text];
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && !statement.isTypeOnly) return [(statement.moduleSpecifier as ts.StringLiteral).text];
    return [];
  });
}

function resolveImport(from: string, specifier: string): string | null {
  const base = specifier.startsWith(".") ? resolve(dirname(from), specifier)
    : specifier.startsWith("@ghostly/browser/") ? join(ROOT, "packages/browser/src", specifier.slice("@ghostly/browser/".length))
    : null;
  if (!base) return null;
  return [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find((path) => existsSync(path) && /\.(tsx?|json)$/.test(path)) ?? null;
}

/**
 * Everything the service worker's modules import when it loads. A bundle builds its chunks from these: a module the
 * worker reaches is in a chunk the worker loads, with all it imports, even where the worker uses one constant of it.
 * `@ghostly/core` and packages from npm are named, not followed (core says it has no side effects: its barrel keeps
 * only what is used).
 */
function reachedFrom(entry: string): { modules: string[]; packages: string[] } {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (modules.has(file)) return;
    modules.add(file);
    if (file.endsWith(".json")) return;
    for (const specifier of staticImports(file)) {
      const next = resolveImport(file, specifier);
      if (next) visit(next);
      else packages.add(specifier);
    }
  };
  visit(entry);
  return { modules: [...modules].map((file) => relative(ROOT, file)).sort(), packages: [...packages].sort() };
}

it("the service worker loads none of the app page's modules but the strings it shows", () => {
  // Chrome starts the worker again after 30 s idle, at each event. Through the shared UI's settings, for one constant,
  // it loaded every English string of the app, the device store and React: 0.46 MB instead of 0.06 MB.
  const { modules, packages } = reachedFrom(join(ROOT, "apps/extension/src/background.ts"));
  expect(modules.filter((file) => file.startsWith("apps/ui/"))).toEqual(["apps/ui/src/lib/appWebsite.ts", "apps/ui/src/locales/en/services.json"]);
  expect(packages).toEqual(["@ghostly/core"]);
});

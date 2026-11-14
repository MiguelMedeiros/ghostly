import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { build, type Rollup } from "vite";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../..");

/** The modules a library build exporting `code` renders, as paths from the repository root. */
async function rendered(code: string): Promise<string[]> {
  const dir = mkdtempSync(join(ROOT, "node_modules/.ghostly-browser-ui-side-effects-"));
  try {
    writeFileSync(join(dir, "entry.js"), code);
    const output = await build({
      root: dir, configFile: false, logLevel: "silent",
      build: { write: false, minify: false, lib: { entry: join(dir, "entry.js"), formats: ["es"], fileName: "bundle" } },
    }) as Rollup.RollupOutput[];
    return output[0].output.filter((file) => file.type === "chunk")
      .flatMap((chunk) => Object.entries((chunk as Rollup.OutputChunk).modules))
      .filter(([, module]) => module.renderedLength > 0).map(([id]) => relative(ROOT, id.replace(/\?.*$/, "")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * `@ghostly/browser` and the shared UI (apps/ui) name the modules that do something when they load in `sideEffects`.
 * Without it a bundler keeps every module an import names in case loading it does something: one helper from
 * `platform/sync` brought the engine client, React and Tauri's API along.
 */
it("a build that takes one helper from @ghostly/browser carries only the modules it uses", async () => {
  const modules = await rendered(`export { sessionForPeer } from "@ghostly/browser/platform/sync";\n`);
  expect(modules).toContain("packages/browser/src/platform/sync.ts");
  expect(modules).not.toContain("packages/browser/src/platform/engine.ts");
  expect(modules.filter((id) => id.includes("node_modules/react/"))).toEqual([]);
}, 60_000);

it("a build that takes one helper from a module of the shared UI carries only the modules it uses", async () => {
  const modules = await rendered(`export { pickSheetText } from "${ROOT}/apps/ui/src/lib/apps/webFiles.ts";\n`);
  expect(modules).toContain("apps/ui/src/lib/apps/webFiles.ts");
  expect(modules).not.toContain("apps/ui/src/lib/apps/broker.ts");
  expect(modules).not.toContain("packages/core/src/miniApp.ts");
}, 60_000);

/** Top-level statements that only declare: a module made of these does nothing when it loads. */
const DECLARING = new Set([
  ts.SyntaxKind.ImportDeclaration, ts.SyntaxKind.ImportEqualsDeclaration, ts.SyntaxKind.ExportDeclaration,
  ts.SyntaxKind.ExportAssignment, ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.InterfaceDeclaration, ts.SyntaxKind.TypeAliasDeclaration, ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.ModuleDeclaration, ts.SyntaxKind.VariableStatement, ts.SyntaxKind.EmptyStatement,
]);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test" ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/**
 * What lets a module stay out of `sideEffects`: loading it only declares things (a `const x = f()` counts as a
 * declaration, as in core's guard). A module that runs a statement when it loads (a listener it adds, ids it reserves,
 * a worker's `onmessage`) is named there, or a build that uses none of its exports would drop the statement:
 * `seedLists.ts` is imported only for what it adds to the secret guard. Bare imports are of CSS only.
 */
describe.each([["packages/browser"], ["apps/ui"]])("%s", (dir) => {
  const manifest = join(ROOT, dir, "package.json");
  const declared: string[] = (existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")).sideEffects : null) ?? [];
  const files = declared.filter((pattern) => pattern.startsWith("./")).map((pattern) => pattern.slice(2));

  it("names in sideEffects every module that runs a statement when it loads, and only those", () => {
    const running: string[] = [];
    const bare: string[] = [];
    for (const path of sources(join(ROOT, dir, "src"))) {
      const name = relative(join(ROOT, dir), path);
      const source = ts.createSourceFile(name, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
      if (source.statements.some((statement) => !DECLARING.has(statement.kind))) running.push(name);
      for (const statement of source.statements) {
        if (ts.isImportDeclaration(statement) && !statement.importClause && !/\.css["']$/.test(statement.moduleSpecifier.getText())) bare.push(`${name}: ${statement.getText()}`);
      }
    }
    expect(running.sort()).toEqual([...files].sort());
    expect(bare).toEqual([]);
  });

  it("names in sideEffects files that exist, and nothing broader than CSS", () => {
    expect(files.filter((file) => !existsSync(join(ROOT, dir, file)))).toEqual([]);
    expect(declared.filter((pattern) => !pattern.startsWith("./") && pattern !== "*.css")).toEqual([]);
  });
});

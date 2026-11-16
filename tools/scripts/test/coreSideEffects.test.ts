import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { build, type Rollup } from "vite";
import { expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../..");
const CORE = join(ROOT, "packages/core/src");

/**
 * `@ghostly/core` is imported through its barrel everywhere. Without `"sideEffects": false` a bundler has to run
 * every module the barrel names, so the extension's background worker, which takes a few byte helpers from it, loaded
 * all of the protocol (ghostlink, groups, payments: about 0.75 MB) each time the browser woke it.
 */
it("a build that takes a few helpers from @ghostly/core's barrel carries only the modules they live in", async () => {
  const dir = mkdtempSync(join(ROOT, "node_modules/.ghostly-core-side-effects-"));
  try {
    writeFileSync(join(dir, "entry.js"), `export { concatBytes, fromBase64, toBase64, utf8Encode } from "@ghostly/core";\n`);
    const output = await build({
      root: dir, configFile: false, logLevel: "silent",
      build: { write: false, minify: false, lib: { entry: join(dir, "entry.js"), formats: ["es"], fileName: "bundle" } },
    }) as Rollup.RollupOutput[];
    const chunk = output[0].output.find((file) => file.type === "chunk") as Rollup.OutputChunk;
    const rendered = Object.entries(chunk.modules).filter(([, module]) => module.renderedLength > 0).map(([id]) => id);
    const core = rendered.filter((id) => id.includes("/packages/core/src/")).map((id) => id.slice(id.indexOf("/packages/core/src/") + 19));
    expect(core).toContain("bytes.ts");
    expect(core).not.toContain("ghostlink.ts");
    expect(core).not.toContain("groupSession.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

/**
 * What lets core say `"sideEffects": false`: loading a module only declares things. A top-level statement that does
 * something (a call, an assignment, a loop) would be dropped from a build that uses none of its module's exports.
 */
it("no module of @ghostly/core runs a statement when it loads", () => {
  const allowed = new Set([
    ts.SyntaxKind.ImportDeclaration, ts.SyntaxKind.ImportEqualsDeclaration, ts.SyntaxKind.ExportDeclaration,
    ts.SyntaxKind.ExportAssignment, ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.ClassDeclaration,
    ts.SyntaxKind.InterfaceDeclaration, ts.SyntaxKind.TypeAliasDeclaration, ts.SyntaxKind.EnumDeclaration,
    ts.SyntaxKind.ModuleDeclaration, ts.SyntaxKind.VariableStatement, ts.SyntaxKind.EmptyStatement,
  ]);
  const statements: string[] = [];
  for (const name of readdirSync(CORE).filter((file) => file.endsWith(".ts"))) {
    const source = ts.createSourceFile(name, readFileSync(join(CORE, name), "utf8"), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (allowed.has(statement.kind)) continue;
      const { line } = source.getLineAndCharacterOfPosition(statement.getStart());
      statements.push(`${name}:${line + 1} ${ts.SyntaxKind[statement.kind]}`);
    }
  }
  expect(statements).toEqual([]);
  expect(JSON.parse(readFileSync(join(ROOT, "packages/core/package.json"), "utf8")).sideEffects).toBe(false);
});

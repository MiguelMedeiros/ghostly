// Prints the catalogue the site shows (lib/wisps.ts, evaluated) as JSON, to compare two checkouts:
//   node scripts/catalog-snapshot.mjs [other-checkout/website/lib] > before.json
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Optional: the lib/ directory of another checkout (after its own `npm run sync:references`).
const lib = resolve(process.argv[2] ?? fileURLToPath(new URL("../lib", import.meta.url)));
const out = mkdtempSync(join(tmpdir(), "catalog-snapshot-"));
mkdirSync(out, { recursive: true });
for (const name of readdirSync(lib)) {
  if (name.endsWith(".json")) copyFileSync(join(lib, name), join(out, name));
  if (!/^(wisps|wisp-groups|wisp-editorial|status)\.ts$/.test(name)) continue;
  const { outputText } = ts.transpileModule(readFileSync(join(lib, name), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, resolveJsonModule: true },
  });
  writeFileSync(join(out, name.replace(/\.ts$/, ".js")), outputText);
}
writeFileSync(join(out, "package.json"), '{"type":"commonjs"}');
const { wisps, GROUPS } = createRequire(join(out, "x.js"))("./wisps.js");
rmSync(out, { recursive: true, force: true });
console.log(JSON.stringify({ groups: GROUPS, wisps }, null, 2));

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * tsc emits the declarations of everything the entry points reach, under dist/types/{sdk,browser,core}.
 * The browser sources import the protocol as `@ghostly/core`, a workspace package a tarball's user does
 * not have: each such import becomes a relative path to the emitted core declarations.
 *
 * tsc keeps relative specifiers as the sources wrote them, without an extension, which `moduleResolution: "NodeNext"`
 * refuses in an ES module package: each gets the `.js` (or `/index.js`) of the declaration file it names.
 */
const types = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/types");
const core = join(types, "core/src/index.js");
function walk(dir) {
  return readdirSync(dir).flatMap((name) => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : path.endsWith(".d.ts") ? [path] : []; });
}
let rewritten = 0;
for (const file of walk(types)) {
  const before = readFileSync(file, "utf8");
  let target = relative(dirname(file), core).split("\\").join("/");
  if (!target.startsWith(".")) target = `./${target}`;
  const after = before
    .replace(/(["'])@ghostly\/core\1/g, `$1${target}$1`)
    .replace(/(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']*)\2/g, (whole, lead, quote, spec) => {
      if (/\.(js|mjs|cjs|json)$/.test(spec)) return whole;
      spec = spec.replace(/\.tsx?$/, "");
      const base = resolve(dirname(file), spec);
      if (existsSync(`${base}.d.ts`)) return `${lead}${quote}${spec}.js${quote}`;
      if (existsSync(join(base, "index.d.ts"))) return `${lead}${quote}${spec}/index.js${quote}`;
      throw new Error(`${relative(types, file)}: no declaration for ${spec}`);
    });
  if (after !== before) { writeFileSync(file, after); rewritten++; }
}
if (!statSync(core.replace(/\.js$/, ".d.ts"), { throwIfNoEntry: false })) throw new Error("The core declarations were not emitted");
console.log(`Declarations ready: ${rewritten} files now import the bundled core and name their files as NodeNext needs.`);

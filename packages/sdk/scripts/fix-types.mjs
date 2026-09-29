import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * tsc emits the declarations of everything the entry points reach, under dist/types/{sdk,browser,core}.
 * The browser sources import the protocol as `@ghostly/core`, a workspace package a tarball's user does
 * not have: each such import becomes a relative path to the emitted core declarations.
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
  const after = before.replace(/(["'])@ghostly\/core\1/g, `$1${target}$1`);
  if (after !== before) { writeFileSync(file, after); rewritten++; }
}
if (!statSync(core.replace(/\.js$/, ".d.ts"), { throwIfNoEntry: false })) throw new Error("The core declarations were not emitted");
console.log(`Declarations ready: ${rewritten} files now import the bundled core.`);

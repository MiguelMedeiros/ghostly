import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** JavaScript with Vite, declarations with tsc, then the declarations' `@ghostly/core` imports made relative. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
rmSync(resolve(root, "dist"), { recursive: true, force: true });
const run = (file, args) => execFileSync(file, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
run("npx", ["vite", "build"]);
run("npx", ["tsc", "-p", "tsconfig.build.json"]);
run("node", ["scripts/fix-types.mjs"]);

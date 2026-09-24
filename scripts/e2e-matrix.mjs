#!/usr/bin/env node
/**
 * npm run e2e:matrix                      every generated scenario
 * npm run e2e:matrix -- --only mx-1a2b3c4d[,mx-…]   reproduce one (or a few) by id
 * npm run e2e:matrix -- --combo client=web-web,delivery=dht,…   one combination, generated or not (the rest filled in); repeatable
 * npm run e2e:matrix -- --list            print the matrix, run nothing
 * npm run e2e:matrix -- --shard 2/4       one shard of it (the nightly workflow runs four)
 * npm run e2e:matrix -- --docs            after the run, write the summary into docs/TESTING.md
 * npm run e2e:matrix -- --no-build        use the extension already in extension/dist
 *
 * Anything else is handed to Playwright (`--headed`, `--workers 1`, `-g …`).
 * `.env.e2e` (written by the ephemeral environment, `npm run e2e:infra:up`) is
 * loaded first, without overriding what is already set: it is what tells each
 * scenario which infrastructure is up, and a scenario whose infrastructure is
 * missing is skipped with the reason, never failed.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const env = { ...process.env };

const envFile = resolve(root, process.env.E2E_ENV_FILE ?? ".env.e2e");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || line.trimStart().startsWith("#")) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, "$2");
    if (env[match[1]] === undefined) env[match[1]] = value;
  }
}

const take = (flag) => {
  const at = args.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
  if (at < 0) return undefined;
  const [arg] = args.splice(at, 1);
  if (arg.includes("=")) return arg.slice(flag.length + 1);
  const [value] = args.splice(at, 1);
  if (value === undefined) throw new Error(`${flag} needs a value`);
  return value;
};
const flag = (name) => {
  const at = args.indexOf(name);
  if (at < 0) return false;
  args.splice(at, 1);
  return true;
};

const only = take("--only");
const combos = [];
for (let combo = take("--combo"); combo !== undefined; combo = take("--combo")) combos.push(combo);
const list = flag("--list");
const docs = flag("--docs");
const noBuild = flag("--no-build");
if (only) env.MATRIX_ONLY = only;
if (combos.length) env.MATRIX_COMBO = combos.join(";");

const run = (command, commandArgs) => {
  const result = spawnSync(command, commandArgs, { cwd: root, env, stdio: "inherit", shell: process.platform === "win32" });
  return result.status ?? 1;
};

if (list) process.exit(run("npx", ["playwright", "test", "-c", "e2e/playwright.matrix.config.ts", "--list", ...args]));

// Scenarios with an extension peer need extension/dist; the web build is the config's web server.
if (!noBuild && !env.E2E_WEB_URL) {
  const status = run("npm", ["run", "build:extension"]);
  if (status !== 0) process.exit(status);
}

const status = run("npx", ["playwright", "test", "-c", "e2e/playwright.matrix.config.ts", ...args]);
if (docs) run("node", ["scripts/matrix-docs.mjs"]);
process.exit(status);

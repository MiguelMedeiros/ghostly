#!/usr/bin/env node
// npm run capture (from website/): re-shoots every app screenshot the site shows.
//
//   1. joins the shared regtest environment (npm run e2e:infra:use -- --host <host>; never starts,
//      resets or seeds one), which funds the wallets with test coins;
//   2. builds the web app and the extension (skip with --no-build);
//   3. serves the web app with vite preview on CAPTURE_PORT (4380);
//   4. runs the capture specs beside this file (Playwright, CAPTURE_WORKERS=2);
//   5. turns each PNG into a 2x WebP in public/screenshots/current/ under its stable name, and
//      leaves the x-* shots (for looking at, never committed) in the scratch folder it prints;
//   6. stops the server.
//
// Arguments after `--` go to Playwright: `npm run capture -- sats.spec.ts`, `-- -g phone`.
// ONLY=chat,file saves just the shots whose names start with those.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const WEBSITE = join(REPO, "website");
const OUT = join(WEBSITE, "public/screenshots/current");
const PORT = Number(process.env.CAPTURE_PORT) || 4380;
const HOST = process.env.CAPTURE_INFRA_HOST || "one";

const args = process.argv.slice(2);
const build = !args.includes("--no-build");
const playwrightArgs = args.filter((a) => a !== "--no-build");

const log = (m) => console.log(`[capture] ${m}`);
function run(cmd, cmdArgs, options = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd: REPO, stdio: "inherit", ...options });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(" ")} exited with ${r.status}`);
}

// 1. The shared environment, as it is.
log(`joining the shared e2e environment on "${HOST}"`);
run(process.execPath, ["e2e/infra/infra.mjs", "use", "--host", HOST]);

// 2. What the shots are taken of.
if (build) {
  log("building the web app and the extension");
  run("npm", ["run", "build:web"]);
  run("npm", ["run", "build:extension"]);
}

// 3. The web app.
log(`serving the web app on http://localhost:${PORT}`);
const server = spawn("npx", ["vite", "preview", "web", "--port", String(PORT), "--strictPort"], { cwd: REPO, stdio: ["ignore", "pipe", "inherit"], detached: true });
const stop = () => { try { process.kill(-server.pid, "SIGTERM"); } catch { /* already gone */ } };
process.on("exit", stop);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stop(); process.exit(130); });
for (let i = 0; ; i++) {
  if (await fetch(`http://localhost:${PORT}/`).then((r) => r.ok, () => false)) break;
  if (i > 120 || server.exitCode !== null) { stop(); throw new Error(`vite preview did not answer on ${PORT}`); }
  await new Promise((r) => setTimeout(r, 500));
}

// 4. The specs. The Spark counterpart's phrase (worthless regtest sats, funded by hand) is read from
// the test-identities folder when the shell has none; it goes to the environment, never to the output.
const env = { ...process.env, CAPTURE_URL: `http://localhost:${PORT}`, SHOTS: mkdtempSync(join(tmpdir(), "ghostly-shots-")) };
const phrase = join(homedir(), ".ghostly-test-identities/spark-regtest-counterpart");
if (!env.GHOSTLY_SPARK_COUNTERPART && existsSync(phrase)) env.GHOSTLY_SPARK_COUNTERPART = readFileSync(phrase, "utf8").trim();
log(`shots land in ${env.SHOTS}`);
const tests = spawnSync("npx", ["playwright", "test", "-c", "website/scripts/capture/playwright.config.ts", ...playwrightArgs], { cwd: REPO, stdio: "inherit", env });
stop();

// 5. PNG to WebP, 2x as shot, quality 82: only the shots the site uses (no x-*).
const sharp = createRequire(join(WEBSITE, "package.json"))("sharp");
const shots = readdirSync(env.SHOTS).filter((n) => n.endsWith(".png"));
for (const name of shots.filter((n) => !n.startsWith("x-"))) {
  const target = join(OUT, name.replace(/\.png$/, ".webp"));
  await sharp(join(env.SHOTS, name)).webp({ quality: 82, effort: 6 }).toFile(target);
  rmSync(join(env.SHOTS, name));
  log(`wrote ${target.slice(REPO.length)}`);
}
log(`${shots.filter((n) => n.startsWith("x-")).length} x-* shots kept in ${env.SHOTS}`);
process.exit(tests.status ?? 1);

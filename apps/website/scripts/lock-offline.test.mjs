// The site's image runs `npm ci` with the npm of the day's node:26-alpine, on the folder's package.json and lockfile
// alone. The lockfile once kept a package whose peers nothing in it met (@napi-rs/wasm-runtime 1.2.0 asks for
// @emnapi/core ^2.0.0-alpha.3, the lock has 1.10.0), so every `npm ci` asked the registry for those packuments to
// settle the conflict, and when that answer did not come the build stopped on "Missing: @emnapi/core@ from lock file".
// It went unseen while Docker reused the cached deps layer, and broke the 1.3.3 deploy once a package.json line
// changed. A lockfile `npm ci` can install as-is needs nothing from the registry before the tarballs: this runs it
// offline, as a dry run on an empty cache. (npm 10 settles that conflict without asking, so it passes there anyway.)
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const site = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("npm ci settles the site's dependencies from its lockfile alone, with no registry", () => {
  const dir = mkdtempSync(join(tmpdir(), "website-lock-"));
  try {
    for (const file of ["package.json", "package-lock.json"]) copyFileSync(join(site, file), join(dir, file));
    // Without the npm settings a run under the repository passes down (npm_config_*): the root's .npmrc has
    // legacy-peer-deps, which skips peers altogether, and the image has only the folder's two files.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key)));
    const flags = ["--dry-run", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--no-update-notifier", `--cache=${join(dir, ".cache")}`];
    const run = spawnSync("npm", ["ci", ...flags], { cwd: dir, encoding: "utf8", env });
    assert.deepEqual(run.stderr.split("\n").filter((line) => /^npm error (Missing|Invalid):/.test(line)), []);
    assert.equal(run.status, 0, run.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

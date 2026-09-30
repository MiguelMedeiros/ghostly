import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Playwright's globalSetup: builds the headless Ghostly (`packages/cli`) once for the whole run, in the runner, before
 * any worker starts. The build empties `packages/cli/dist` first, so a build inside a worker (as each worker did, and
 * each new worker after a failure) took the files from under the bots another worker was running
 * ("Cannot find module …/dist/assets/…"). Workers only use the build (support/headless.ts).
 */
export default function buildHeadless(): void {
  execFileSync("npm", ["run", "build", "-w", "@ghostlytools/cli"], { cwd: resolve(import.meta.dirname, "../.."), stdio: "ignore" });
}

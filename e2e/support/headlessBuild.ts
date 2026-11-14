import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Playwright's globalSetup: builds the headless Ghostly (`packages/cli`) once for the whole run, in the runner, before
 * any worker starts. The build empties `packages/cli/dist` first, so a build inside a worker (as each worker did, and
 * each new worker after a failure) took the files from under the bots another worker was running
 * ("Cannot find module …/dist/assets/…"). Workers only use the build (support/headless.ts).
 *
 * A failed build says why: its output is kept and the end of it goes into the error (it used to be thrown away, and
 * CI showed only "Command failed").
 */
export default function buildHeadless(): void {
  try {
    execFileSync("npm", ["run", "build", "-w", "@ghostlytools/cli"], { cwd: resolve(import.meta.dirname, "../.."), stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: Buffer; stderr?: Buffer };
    const tail = `${stdout?.toString() ?? ""}\n${stderr?.toString() ?? ""}`.trim().split("\n").slice(-40).join("\n");
    throw new Error(`npm run build -w @ghostlytools/cli failed:\n${tail}`, { cause: error });
  }
}

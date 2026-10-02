import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A workflow that pull request CI does not run (a release, a publish, the full e2e) fails on the day it is needed
 * when a file it names has moved. This holds every workflow to the tree: each script a step runs, each
 * sparse-checkout, `file:`, `hashFiles()` and compose `-f` path, and each folder a step works in, must exist.
 */
const root = resolve(import.meta.dirname, "../../..");
const dir = join(root, ".github/workflows");

/** Folders a workflow makes while it runs (builds, downloads): no checkout has them. */
const MADE_BY_THE_RUN = /(^|\/)(dist|target|node_modules|release-assets|artifacts)(\/|$)/;
const PATH = String.raw`[\w.@-]+(?:/[\w.@*-]+)*`;

/** Every repo-relative path a workflow names, with the folders it may be relative to ("." and the job's working directories). */
function named(text: string) {
  const out: { path: string; from: string[]; folder?: boolean }[] = [];
  // One block per job: a step's `node scripts/x.mjs` is relative to its job's working-directory, if it sets one.
  for (const job of text.split(/^ {2}(?=[\w-]+:\s*$)/m)) {
    const lines = job.split("\n").filter((l) => !/^\s*#/.test(l));
    const folders = lines.flatMap((l) => l.match(new RegExp(String.raw`^\s*working-directory:\s*(${PATH})\s*$`))?.[1] ?? []);
    const from = [".", ...folders];
    for (const path of folders) out.push({ path, from: ["."], folder: true });
    for (const l of lines) {
      const add = (re: RegExp, extra = {}) => {
        for (const m of l.matchAll(re)) out.push({ path: m[1], from, ...extra });
      };
      add(new RegExp(String.raw`(?:^|[\s"'(=])([\w.@-]+/${PATH}\.(?:mjs|cjs|js|ts|sh))(?=$|[\s"')])`, "g"));
      add(new RegExp(String.raw`^\s*(?:sparse-checkout|file):\s*(${PATH})\s*$`, "g"));
      add(new RegExp(String.raw`hashFiles\('(${PATH})'`, "g"));
      add(new RegExp(String.raw`\s-f\s+(${PATH}\.ya?ml)\b`, "g"));
      add(new RegExp(String.raw`(?:^|[\s;&(])cd\s+(${PATH})(?=$|[\s;&)])`, "g"), { folder: true });
    }
  }
  return out.filter((n) => !n.path.includes("*") || n.path.replace(/\/[^/]*\*.*$/, "") !== n.path);
}

const missing = (text: string) =>
  named(text)
    .filter((n) => !MADE_BY_THE_RUN.test(n.path))
    .filter((n) => !n.from.some((f) => existsSync(join(root, f, n.path.replace(/\/[^/]*\*.*$/, "")))))
    .map((n) => n.path);

describe("the workflows' paths", () => {
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));

  it("reads the forms a workflow names a path in", () => {
    const sample = [
      "jobs:",
      "  gate:",
      "    steps:",
      "      - with:",
      "          sparse-checkout: tools/scripts/ci-changes.mjs",
      "          file: apps/web/Dockerfile",
      "      - run: node tools/scripts/gone.mjs --draft=false <<< \"$files\"",
      "      - run: |",
      "          cd apps/gone",
      "          tools/scripts/gone.sh target/release/*.AppImage",
      "  site:",
      "    defaults:",
      "      run:",
      "        working-directory: apps/website",
      "    steps:",
      "      # node scripts/a-comment.mjs",
      "      - run: node scripts/sync-app-deck.mjs --check",
    ].join("\n");
    expect(named(sample).map((n) => n.path)).toEqual([
      "tools/scripts/ci-changes.mjs",
      "tools/scripts/ci-changes.mjs",
      "apps/web/Dockerfile",
      "tools/scripts/gone.mjs",
      "apps/gone",
      "tools/scripts/gone.sh",
      "apps/website",
      "scripts/sync-app-deck.mjs",
    ]);
    expect(missing(sample)).toEqual(["tools/scripts/gone.mjs", "apps/gone", "tools/scripts/gone.sh"]);
  });

  it.each(files)("%s names only files and folders the repository has", (file) => {
    expect(missing(readFileSync(join(dir, file), "utf8"))).toEqual([]);
  });

  it("finds the scripts the release and the gate run", () => {
    const all = files.flatMap((f) => named(readFileSync(join(dir, f), "utf8")).map((n) => n.path));
    expect(all).toEqual(expect.arrayContaining(["tools/scripts/updater-manifest.mjs", "tools/scripts/verify-updater-signatures.mjs", "tools/scripts/ci-changes.mjs", "apps/web/Dockerfile"]));
  });
});

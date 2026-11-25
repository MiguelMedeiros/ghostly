import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { TYPECHECKS } from "../affected/select.mjs";

const root = join(import.meta.dirname, "..", "..", "..");
const read = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));

/**
 * CI's macOS Desktop job (desktop-macos.yml, `npm run desktop:macos:build`) was the slowest job of most full runs, and
 * 46-77 s of its build was `npm run build`'s `tsc -b`: the root tsconfig's type check, which `npm run typecheck` runs
 * in Frontend lint and types on every run the Mac jobs run in. The test-driver build bundles the UI without it.
 */
it("the macOS test-driver build bundles the UI as `npm run build` does, without its type check", () => {
  const scripts = read("package.json").scripts as Record<string, string>;
  const typeCheck = "tsc -b && ";
  expect(scripts.build.startsWith(typeCheck)).toBe(true);
  expect(scripts["desktop:macos:build"]).toContain("--config apps/desktop/tauri.e2e.conf.json");

  const release = read("apps/desktop/tauri.conf.json").build.beforeBuildCommand as string;
  expect(release).toContain("npm run build");
  // `npm run build` is prebuild, then build: the same two, minus the type check.
  const bundle = `${scripts.prebuild} && ${scripts.build.slice(typeCheck.length)}`;
  expect(read("apps/desktop/tauri.e2e.conf.json").build?.beforeBuildCommand).toBe(release.replace("npm run build", bundle));
});

it("the type check it leaves out is one Frontend lint and types runs", () => {
  // `tsc -b` on the root tsconfig, which has noEmit: the same program as `tsc --noEmit`.
  expect(read("tsconfig.json").compilerOptions.noEmit).toBe(true);
  expect(TYPECHECKS.map((t: { cmd: string[] }) => t.cmd.join(" "))).toContain("npx tsc --noEmit");
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "vite";
import { expect, it } from "vitest";
import { checkTranslateFlag, translateGuard } from "../../../apps/web/translateFlag";
import type { AppsTestBuild } from "../../../apps/web/appsTestFlag";
import { RELEASE_GUARDS } from "../changes.mjs";

const ROOT = join(import.meta.dirname, "../../..");

/** What the Tauri CLI hands `beforeBuildCommand` on a release `tauri build`: its target, and no TAURI_ENV_DEBUG at all. */
const TAURI_RELEASE_ENV = { TAURI_ENV_PLATFORM: "darwin", TAURI_ENV_ARCH: "aarch64", TAURI_ENV_FAMILY: "unix", TAURI_ENV_PLATFORM_VERSION: "15.0", TAURI_ENV_TARGET_TRIPLE: "aarch64-apple-darwin" };
/** The same for `tauri android build`, which builds apps/ui too (apps/desktop/tauri.android.conf.json). */
const TAURI_ANDROID_ENV = { TAURI_ENV_PLATFORM: "android", TAURI_ENV_ARCH: "aarch64", TAURI_ENV_FAMILY: "unix", TAURI_ENV_TARGET_TRIPLE: "aarch64-linux-android" };

/** Auto-translation's switch (VITE_TRANSLATE) is made into Desktop builds, and never into the web image, the extension or Android. */
it("takes 1 or nothing, and refuses an image build that carries it", () => {
  expect(checkTranslateFlag({}, "web")).toBe(false);
  expect(checkTranslateFlag({ VITE_TRANSLATE: "" }, "web")).toBe(false);
  expect(checkTranslateFlag({ VITE_TRANSLATE: "1" }, "web")).toBe(true);
  for (const value of ["true", "0", "yes", " 1"]) expect(() => checkTranslateFlag({ VITE_TRANSLATE: value }, "web"), value).toThrow(/"1" or unset/);
  expect(() => checkTranslateFlag({ VITE_TRANSLATE: "1", GHOSTLY_BUILD: "abc123" }, "web")).toThrow(/image build/);
  expect(checkTranslateFlag({ GHOSTLY_BUILD: "abc123" }, "web")).toBe(false);
});

it("Desktop takes it in a release build as in a debug one; the Android app and the extension never", () => {
  // A release `tauri build` sets no TAURI_ENV_DEBUG, nor does the bare `vite build apps/ui` that check:desktop-bundle reads.
  expect(checkTranslateFlag({ VITE_TRANSLATE: "1", ...TAURI_RELEASE_ENV }, "desktop")).toBe(true);
  expect(checkTranslateFlag({ VITE_TRANSLATE: "1", ...TAURI_RELEASE_ENV, TAURI_ENV_PLATFORM: "windows" }, "desktop")).toBe(true);
  expect(checkTranslateFlag({ VITE_TRANSLATE: "1" }, "desktop")).toBe(true);
  // `tauri build --debug` and `tauri dev` add TAURI_ENV_DEBUG=true.
  expect(checkTranslateFlag({ VITE_TRANSLATE: "1", ...TAURI_RELEASE_ENV, TAURI_ENV_DEBUG: "true" }, "desktop")).toBe(true);
  for (const platform of ["android", "ios"]) {
    expect(() => checkTranslateFlag({ VITE_TRANSLATE: "1", ...TAURI_ANDROID_ENV, TAURI_ENV_PLATFORM: platform }, "desktop"), platform).toThrow(/Android or iOS build/);
    expect(() => checkTranslateFlag({ VITE_TRANSLATE: "1", ...TAURI_ANDROID_ENV, TAURI_ENV_PLATFORM: platform, TAURI_ENV_DEBUG: "true" }, "desktop"), platform).toThrow(/Android or iOS build/);
  }
  expect(checkTranslateFlag({ ...TAURI_ANDROID_ENV }, "desktop")).toBe(false);
  expect(() => checkTranslateFlag({ VITE_TRANSLATE: "1", ...TAURI_RELEASE_ENV, GHOSTLY_BUILD: "abc123" }, "desktop")).toThrow(/image build/);
  expect(checkTranslateFlag({ ...TAURI_RELEASE_ENV }, "desktop")).toBe(false);
  expect(() => checkTranslateFlag({ VITE_TRANSLATE: "1", TAURI_ENV_DEBUG: "true" }, "extension")).toThrow(/extension build/);
  expect(() => checkTranslateFlag({ VITE_TRANSLATE: "1" }, "extension")).toThrow(/extension build/);
  expect(checkTranslateFlag({}, "extension")).toBe(false);
});

it("is its own switch: the e2e suite's mini-app switch neither turns it on nor lets it through", () => {
  expect(checkTranslateFlag({ VITE_APPS_TEST: "1" }, "web")).toBe(false);
  expect(checkTranslateFlag({ VITE_APPS_TEST: "1" }, "desktop")).toBe(false);
  expect(() => checkTranslateFlag({ VITE_APPS_TEST: "1", VITE_TRANSLATE: "1" }, "extension")).toThrow(/extension build/);
});

it("the guard reads the env the build compiles in, a .env file included", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ghostly-translate-"));
  const saved = Object.fromEntries(["VITE_TRANSLATE", "GHOSTLY_BUILD", "TAURI_ENV_DEBUG", ...Object.keys(TAURI_RELEASE_ENV), ...Object.keys(TAURI_ANDROID_ENV)].map((key) => [key, process.env[key]]));
  for (const key of Object.keys(saved)) delete process.env[key];
  const resolve = (build: AppsTestBuild) => resolveConfig({ root: dir, envDir: dir, configFile: false, logLevel: "silent", plugins: [translateGuard(build)] }, "build", "production");
  try {
    await expect(resolve("desktop")).resolves.toBeTruthy();
    writeFileSync(join(dir, ".env.production"), "VITE_TRANSLATE=1\n");
    await expect(resolve("extension")).rejects.toThrow(/extension build/);
    await expect(resolve("web")).resolves.toBeTruthy();
    await expect(resolve("desktop")).resolves.toBeTruthy();
    Object.assign(process.env, TAURI_RELEASE_ENV);
    await expect(resolve("desktop")).resolves.toBeTruthy();
    Object.assign(process.env, TAURI_ANDROID_ENV);
    await expect(resolve("desktop")).rejects.toThrow(/Android or iOS build/);
    process.env.GHOSTLY_BUILD = "abc123";
    await expect(resolve("web")).rejects.toThrow(/image build/);
    // An empty one in the shell wins over the .env file's, as the web image's Dockerfile relies on.
    process.env.VITE_TRANSLATE = "";
    await expect(resolve("web")).resolves.toBeTruthy();
    await expect(resolve("desktop")).resolves.toBeTruthy();
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
  }
});

it("every client's build runs the guard, as that client", () => {
  for (const [config, build] of [["apps/web/vite.config.ts", "web"], ["apps/ui/vite.config.ts", "desktop"], ["apps/extension/vite.config.ts", "extension"]]) {
    expect(readFileSync(join(ROOT, config), "utf8"), config).toContain(`translateGuard("${build}")`);
  }
});

it("the web image empties it before its build, a self-hosted one with no GHOSTLY_BUILD included", () => {
  const dockerfile = readFileSync(join(ROOT, "apps/web/Dockerfile"), "utf8");
  const empty = dockerfile.indexOf("ENV VITE_TRANSLATE=\n");
  expect(empty).toBeGreaterThan(0);
  expect(empty).toBeLessThan(dockerfile.indexOf("RUN npm run build -w @ghostly/web"));
});

const workflow = (file: string) => readFileSync(join(ROOT, ".github/workflows", file), "utf8");

/** A job of a workflow, by its key: its text up to the next job. */
function job(text: string, key: string): string {
  const start = text.indexOf(`\n  ${key}:\n`);
  if (start < 0) throw new Error(`no job "${key}"`);
  const next = text.slice(start + 1).search(/\n {2}[a-z][a-z-]*:\n/);
  return text.slice(start, next < 0 ? undefined : start + 1 + next + 1);
}

/** One step of a job, by name: its text up to the next step. */
function step(text: string, name: string): string {
  const start = text.indexOf(`      - name: ${name}\n`);
  if (start < 0) throw new Error(`no step "${name}"`);
  const next = text.indexOf("\n      - name: ", start + 1);
  return text.slice(start, next < 0 ? undefined : next + 1);
}

/** Lines that set it to something, comments left out. */
const setters = (text: string) => text.split("\n").filter((line) => !line.trimStart().startsWith("#") && /VITE_TRANSLATE\s*[:=]\s*(?!""|''|$)/.test(line));

it("only the Desktop builds of a release and CI's Desktop frontend set it: never the web image, the extension or Android", () => {
  const release = workflow("release.yml");
  for (const file of readdirSync(join(ROOT, ".github/workflows")).filter((name) => /\.ya?ml$/.test(name))) {
    const expected = file === "release.yml" ? 1 : file === "ci.yml" ? 2 : 0;
    expect(setters(workflow(file)), file).toHaveLength(expected);
  }
  // In release.yml, for the whole of build-tauri: the `npm run build` that check:desktop-bundle reads and `tauri build`.
  expect(setters(job(release, "build-tauri"))).toEqual([`      VITE_TRANSLATE: \${{ needs.guard.outputs.translate == 'true' && '1' || '' }}`]);
  expect(job(release, "build-tauri")).toContain("    needs: [guard]\n");
  expect(job(release, "build-tauri")).toMatch(/\n {4}env:\n {6}VITE_TRANSLATE: /);
  // In ci.yml, the Desktop frontend and its bundle check, not the extension's or the web app's build after them.
  const frontend = job(workflow("ci.yml"), "frontend-build");
  for (const name of ["Build", "Desktop build carries its Desktop wiring"]) expect(setters(step(frontend, name)), name).toEqual(['          VITE_TRANSLATE: "1"']);
  for (const name of ["Build browser extension", "Build web app"]) expect(step(frontend, name), name).not.toContain("VITE_TRANSLATE");
});

// The owner's decision (2026-10-27): translation ships in 1.7.0, on Desktop. A patch of an older release cut after it
// merged builds without it.
it("a release carries it from TRANSLATE_FROM on, decided by the tag's version", () => {
  const release = workflow("release.yml");
  const from = release.match(/^ {2}TRANSLATE_FROM: "(\d+\.\d+\.\d+)"$/m)?.[1] ?? "";
  expect(from).toBe("1.7.0");
  expect(RELEASE_GUARDS.find((guard: { about: string }) => guard.about === "auto-translation")?.from).toBe(from);
  expect(job(release, "guard")).toContain("      translate: ${{ steps.translate.outputs.translate }}\n");
  const text = step(job(release, "guard"), "Whether this release carries translation");
  expect(text).toContain("        id: translate\n");
  const script = text.slice(text.indexOf("        run: |\n") + 15).split("\n").map((line) => line.replace(/^ {10}/, "")).join("\n");
  const dir = mkdtempSync(join(tmpdir(), "release-translate-"));
  try {
    const carries = (tag: string) => {
      const output = join(dir, "github-output");
      writeFileSync(output, "");
      execFileSync("bash", ["-e", "-c", script], { cwd: dir, env: { PATH: process.env.PATH ?? "", RELEASE_TAG: tag, TRANSLATE_FROM: from, GITHUB_OUTPUT: output }, stdio: "ignore" });
      return readFileSync(output, "utf8");
    };
    for (const tag of ["v1.6.0", "v1.6.1", "v1.6.10", "v1.2.0"]) expect(carries(tag), tag).toBe("translate=false\n");
    for (const tag of ["v1.7.0", "v1.7.1", "v1.10.0", "v2.0.0"]) expect(carries(tag), tag).toBe("translate=true\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

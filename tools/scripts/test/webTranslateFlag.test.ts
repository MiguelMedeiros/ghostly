import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "vite";
import { expect, it } from "vitest";
import { checkTranslateFlag, translateGuard } from "../../../apps/web/translateFlag";
import type { AppsTestBuild } from "../../../apps/web/appsTestFlag";

const ROOT = join(import.meta.dirname, "../../..");

/** What the Tauri CLI hands `beforeBuildCommand` on a release `tauri build`: its target, and no TAURI_ENV_DEBUG at all. */
const TAURI_RELEASE_ENV = { TAURI_ENV_PLATFORM: "darwin", TAURI_ENV_ARCH: "aarch64", TAURI_ENV_FAMILY: "unix", TAURI_ENV_PLATFORM_VERSION: "15.0", TAURI_ENV_TARGET_TRIPLE: "aarch64-apple-darwin" };

/** Auto-translation's switch (VITE_TRANSLATE) is made into a development build and can never reach one that ships. */
it("takes 1 or nothing, and refuses an image build that carries it", () => {
  expect(checkTranslateFlag({}, "web")).toBe(false);
  expect(checkTranslateFlag({ VITE_TRANSLATE: "" }, "web")).toBe(false);
  expect(checkTranslateFlag({ VITE_TRANSLATE: "1" }, "web")).toBe(true);
  for (const value of ["true", "0", "yes", " 1"]) expect(() => checkTranslateFlag({ VITE_TRANSLATE: value }, "web"), value).toThrow(/"1" or unset/);
  expect(() => checkTranslateFlag({ VITE_TRANSLATE: "1", GHOSTLY_BUILD: "abc123" }, "web")).toThrow(/image build/);
  expect(checkTranslateFlag({ GHOSTLY_BUILD: "abc123" }, "web")).toBe(false);
});

it("Desktop takes it in a debug build only, the extension never", () => {
  // `tauri build --debug` and `tauri dev` add TAURI_ENV_DEBUG=true.
  expect(checkTranslateFlag({ VITE_TRANSLATE: "1", ...TAURI_RELEASE_ENV, TAURI_ENV_DEBUG: "true" }, "desktop")).toBe(true);
  // A release `tauri build` sets no TAURI_ENV_DEBUG; nor does a bare `vite build apps/ui`. Both are refused.
  expect(() => checkTranslateFlag({ VITE_TRANSLATE: "1", ...TAURI_RELEASE_ENV }, "desktop")).toThrow(/Desktop release build/);
  expect(() => checkTranslateFlag({ VITE_TRANSLATE: "1", ...TAURI_RELEASE_ENV, TAURI_ENV_DEBUG: "false" }, "desktop")).toThrow(/Desktop release build/);
  expect(() => checkTranslateFlag({ VITE_TRANSLATE: "1" }, "desktop")).toThrow(/Desktop release build/);
  expect(() => checkTranslateFlag({ VITE_TRANSLATE: "1", TAURI_ENV_DEBUG: "true", GHOSTLY_BUILD: "abc123" }, "desktop")).toThrow(/image build/);
  expect(checkTranslateFlag({ ...TAURI_RELEASE_ENV }, "desktop")).toBe(false);
  expect(() => checkTranslateFlag({ VITE_TRANSLATE: "1", TAURI_ENV_DEBUG: "true" }, "extension")).toThrow(/extension build/);
  expect(checkTranslateFlag({}, "extension")).toBe(false);
});

it("is its own switch: the e2e suite's mini-app switch neither turns it on nor lets it through", () => {
  expect(checkTranslateFlag({ VITE_APPS_TEST: "1" }, "web")).toBe(false);
  expect(() => checkTranslateFlag({ VITE_APPS_TEST: "1", VITE_TRANSLATE: "1" }, "desktop")).toThrow(/Desktop release build/);
});

it("the guard reads the env the build compiles in, a .env file included", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ghostly-translate-"));
  const saved = Object.fromEntries(["VITE_TRANSLATE", "GHOSTLY_BUILD", "TAURI_ENV_DEBUG", ...Object.keys(TAURI_RELEASE_ENV)].map((key) => [key, process.env[key]]));
  for (const key of Object.keys(saved)) delete process.env[key];
  const resolve = (build: AppsTestBuild) => resolveConfig({ root: dir, envDir: dir, configFile: false, logLevel: "silent", plugins: [translateGuard(build)] }, "build", "production");
  try {
    await expect(resolve("desktop")).resolves.toBeTruthy();
    writeFileSync(join(dir, ".env.production"), "VITE_TRANSLATE=1\n");
    await expect(resolve("extension")).rejects.toThrow(/extension build/);
    await expect(resolve("web")).resolves.toBeTruthy();
    Object.assign(process.env, TAURI_RELEASE_ENV);
    await expect(resolve("desktop")).rejects.toThrow(/Desktop release build/);
    process.env.TAURI_ENV_DEBUG = "true";
    await expect(resolve("desktop")).resolves.toBeTruthy();
    // An empty one in the shell wins over the .env file's, as the web image's Dockerfile relies on.
    process.env.VITE_TRANSLATE = "";
    await expect(resolve("extension")).resolves.toBeTruthy();
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

it("no workflow sets it: until the feature ships, it is made by hand", () => {
  for (const file of readdirSync(join(ROOT, ".github/workflows")).filter((name) => /\.ya?ml$/.test(name))) {
    const lines = readFileSync(join(ROOT, ".github/workflows", file), "utf8").split("\n").filter((line) => !line.trimStart().startsWith("#"));
    expect(lines.filter((line) => /VITE_TRANSLATE\s*[:=]\s*(?!""|''|$)/.test(line)), file).toEqual([]);
  }
});

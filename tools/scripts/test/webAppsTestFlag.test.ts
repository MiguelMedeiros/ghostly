import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "vite";
import { expect, it } from "vitest";
import { appsTestGuard, checkAppsTestFlag, type AppsTestBuild } from "../../../apps/web/appsTestFlag";

// covers: apps.web-sandbox, apps.desktop-sandbox

const ROOT = join(import.meta.dirname, "../../..");

/** The e2e suite's mini-app switch (VITE_APPS_TEST) is made into a build and can never reach a deployed one. */
it("takes 1 or nothing, and refuses an image build that carries it", () => {
  expect(checkAppsTestFlag({})).toBe(false);
  expect(checkAppsTestFlag({ VITE_APPS_TEST: "" })).toBe(false);
  expect(checkAppsTestFlag({ VITE_APPS_TEST: "1" })).toBe(true);
  expect(() => checkAppsTestFlag({ VITE_APPS_TEST: "true" })).toThrow();
  expect(() => checkAppsTestFlag({ VITE_APPS_TEST: "1", GHOSTLY_BUILD: "abc123" })).toThrow(/image build/);
  expect(checkAppsTestFlag({ GHOSTLY_BUILD: "abc123" })).toBe(false);
});

it("the web image empties it before its build", () => {
  const dockerfile = readFileSync(join(import.meta.dirname, "../../../apps/web/Dockerfile"), "utf8");
  const empty = dockerfile.indexOf("ENV VITE_APPS_TEST=\n");
  expect(empty).toBeGreaterThan(0);
  expect(empty).toBeLessThan(dockerfile.indexOf("RUN npm run build -w @ghostly/web"));
});

it("the app reads it only from the build (import.meta.env), never from storage or the address", () => {
  for (const file of ["apps/web/src/host.ts", "apps/web/src/main.tsx", "apps/ui/src/desktop/host.ts", "apps/ui/src/lib/apps/flag.ts"]) {
    const text = readFileSync(join(ROOT, file), "utf8");
    const lines = text.split("\n").filter((l) => l.includes("VITE_APPS_TEST") && !/^\s*(\/\/|\/\*\*|\*)/.test(l));
    expect(lines.length, file).toBeGreaterThan(0);
    for (const line of lines) expect(line, file).toMatch(/import\.meta\.env\??\.VITE_APPS_TEST === "1"/);
  }
});

it("Desktop takes it in a debug build only, the extension never", () => {
  // `tauri build --debug` (every e2e build of Desktop) hands its build command TAURI_ENV_DEBUG=true.
  expect(checkAppsTestFlag({ VITE_APPS_TEST: "1", TAURI_ENV_DEBUG: "true" }, "desktop")).toBe(true);
  // `vite build apps/ui` on its own makes no app.
  expect(checkAppsTestFlag({ VITE_APPS_TEST: "1" }, "desktop")).toBe(true);
  // A release build: `tauri build` without --debug.
  for (const debug of ["false", "0", ""]) expect(() => checkAppsTestFlag({ VITE_APPS_TEST: "1", TAURI_ENV_DEBUG: debug }, "desktop")).toThrow(/Desktop release build/);
  expect(() => checkAppsTestFlag({ VITE_APPS_TEST: "1", TAURI_ENV_DEBUG: "true", GHOSTLY_BUILD: "abc123" }, "desktop")).toThrow(/image build/);
  expect(checkAppsTestFlag({ TAURI_ENV_DEBUG: "false" }, "desktop")).toBe(false);
  expect(checkAppsTestFlag({ VITE_APPS_TEST: "", TAURI_ENV_DEBUG: "false" }, "desktop")).toBe(false);
  expect(() => checkAppsTestFlag({ VITE_APPS_TEST: "1" }, "extension")).toThrow(/extension build/);
  expect(checkAppsTestFlag({}, "extension")).toBe(false);
  // The web app is never inside `tauri build`: Tauri's variables mean nothing to it.
  expect(checkAppsTestFlag({ VITE_APPS_TEST: "1", TAURI_ENV_DEBUG: "false" })).toBe(true);
});

it("the guard reads the env the build compiles in, a .env file included", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ghostly-apps-test-"));
  const flag = process.env.VITE_APPS_TEST;
  const debug = process.env.TAURI_ENV_DEBUG;
  delete process.env.VITE_APPS_TEST;
  const resolve = (build: AppsTestBuild) => resolveConfig({ root: dir, envDir: dir, configFile: false, logLevel: "silent", plugins: [appsTestGuard(build)] }, "build", "production");
  try {
    await expect(resolve("extension")).resolves.toBeTruthy();
    writeFileSync(join(dir, ".env.production"), "VITE_APPS_TEST=1\n");
    await expect(resolve("extension")).rejects.toThrow(/extension build/);
    process.env.TAURI_ENV_DEBUG = "false";
    await expect(resolve("desktop")).rejects.toThrow(/Desktop release build/);
    process.env.TAURI_ENV_DEBUG = "true";
    await expect(resolve("desktop")).resolves.toBeTruthy();
  } finally {
    if (flag === undefined) delete process.env.VITE_APPS_TEST; else process.env.VITE_APPS_TEST = flag;
    if (debug === undefined) delete process.env.TAURI_ENV_DEBUG; else process.env.TAURI_ENV_DEBUG = debug;
    rmSync(dir, { recursive: true, force: true });
  }
});

it("every client's build runs the guard, as that client", () => {
  for (const [config, build] of [["apps/web/vite.config.ts", "web"], ["apps/ui/vite.config.ts", "desktop"], ["apps/extension/vite.config.ts", "extension"]]) {
    expect(readFileSync(join(ROOT, config), "utf8"), config).toContain(`plugins: [appsTestGuard("${build}"), `);
  }
});

/** A workflow's steps, each from its `- name:` line to the next one. */
const steps = (file: string) => readFileSync(join(ROOT, ".github/workflows", file), "utf8").split(/\n(?= +- name: )/);

it("CI makes a Desktop e2e build with it in debug only, and an extension build never", () => {
  let desktop = 0;
  for (const file of readdirSync(join(ROOT, ".github/workflows")).filter((name) => /\.ya?ml$/.test(name))) {
    for (const step of steps(file).filter((text) => text.includes('VITE_APPS_TEST: "1"'))) {
      expect(step, file).not.toMatch(/build:extension|tauri-action/);
      if (/tauri -- build/.test(step)) {
        expect(step, file).toMatch(/tauri -- build --debug/);
        desktop++;
      }
    }
  }
  expect(desktop).toBeGreaterThan(0);
});

it("the release workflow empties it for the Desktop and extension builds", () => {
  const release = steps("release.yml");
  for (const marker of [/uses: tauri-apps\/tauri-action@/, /run: npm run build:extension\n/]) {
    const found = release.filter((step) => marker.test(step));
    expect(found, String(marker)).toHaveLength(1);
    expect(found[0], String(marker)).toMatch(/\n +VITE_APPS_TEST: ""\n/);
  }
});

it("the e2e build's unguarded runner is the runner with only its hint guard taken out, and both still parse", async () => {
  const { withoutHintGuard } = await import("../../../apps/web/runnerPolicy");
  const runner = readFileSync(join(import.meta.dirname, "../../../apps/web/public/app-frame.html"), "utf8");
  expect(runner.match(/ghostly:hint-guard:start/g)).toHaveLength(1);
  const unguarded = withoutHintGuard(runner);
  expect(unguarded).not.toContain("ghostly:hint-guard");
  expect(unguarded).toContain("const hintGuard = null;");
  expect(runner.replace(/\n {2}\/\/ ghostly:hint-guard:start\n[\s\S]*?\n {2}\/\/ ghostly:hint-guard:end\n/, "")).toBe(unguarded.replace("\n  const hintGuard = null;\n", ""));
  for (const page of [runner, unguarded]) {
    // The runner's one inline script, between its tags (the file is ours: one lower-case <script>).
    const code = page.slice(page.indexOf("<script>") + "<script>".length, page.lastIndexOf("</script>"));
    expect(() => new Function(code)).not.toThrow();
  }
  expect(() => withoutHintGuard("<script></script>")).toThrow(/hint-guard/);
});

it("only an e2e build emits the unguarded runner: a production build (no VITE_APPS_TEST) has none, and none comes from public/", async () => {
  const { runnerHeaders, UNGUARDED_RUNNER_PATH } = await import("../../../apps/web/runnerPolicy");
  const emitted = (env: string | undefined) => {
    const before = process.env.VITE_APPS_TEST;
    const build = process.env.GHOSTLY_BUILD;
    if (env === undefined) delete process.env.VITE_APPS_TEST; else process.env.VITE_APPS_TEST = env;
    delete process.env.GHOSTLY_BUILD;
    try {
      const files: string[] = [];
      const hook = runnerHeaders().generateBundle as unknown as (this: { emitFile(file: { fileName: string }): void }) => void;
      hook.call({ emitFile: (file) => files.push(file.fileName) });
      return files;
    } finally {
      if (before === undefined) delete process.env.VITE_APPS_TEST; else process.env.VITE_APPS_TEST = before;
      if (build !== undefined) process.env.GHOSTLY_BUILD = build;
    }
  };
  expect(emitted(undefined)).toEqual([]);
  expect(emitted("")).toEqual([]);
  expect(emitted("1")).toEqual([UNGUARDED_RUNNER_PATH.slice(1)]);
  expect(existsSync(join(import.meta.dirname, "../../../apps/web/public", UNGUARDED_RUNNER_PATH.slice(1)))).toBe(false);
});

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
  expect(checkAppsTestFlag({}, "web")).toBe(false);
  expect(checkAppsTestFlag({ VITE_APPS_TEST: "" }, "web")).toBe(false);
  expect(checkAppsTestFlag({ VITE_APPS_TEST: "1" }, "web")).toBe(true);
  expect(() => checkAppsTestFlag({ VITE_APPS_TEST: "true" }, "web")).toThrow();
  expect(() => checkAppsTestFlag({ VITE_APPS_TEST: "1", GHOSTLY_BUILD: "abc123" }, "web")).toThrow(/image build/);
  expect(checkAppsTestFlag({ GHOSTLY_BUILD: "abc123" }, "web")).toBe(false);
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

/** What the Tauri CLI hands `beforeBuildCommand` on a release `tauri build`: its target, and no TAURI_ENV_DEBUG at all. */
const TAURI_RELEASE_ENV = { TAURI_ENV_PLATFORM: "darwin", TAURI_ENV_ARCH: "aarch64", TAURI_ENV_FAMILY: "unix", TAURI_ENV_PLATFORM_VERSION: "15.0", TAURI_ENV_TARGET_TRIPLE: "aarch64-apple-darwin" };

it("Desktop takes it in a debug build only, the extension never", () => {
  // `tauri build --debug` (every e2e build of Desktop) and `tauri dev` add TAURI_ENV_DEBUG=true.
  expect(checkAppsTestFlag({ VITE_APPS_TEST: "1", ...TAURI_RELEASE_ENV, TAURI_ENV_DEBUG: "true" }, "desktop")).toBe(true);
  // A release `tauri build` sets no TAURI_ENV_DEBUG; nor does a bare `vite build apps/ui`. Both are refused.
  expect(() => checkAppsTestFlag({ VITE_APPS_TEST: "1", ...TAURI_RELEASE_ENV }, "desktop")).toThrow(/Desktop release build/);
  expect(() => checkAppsTestFlag({ VITE_APPS_TEST: "1" }, "desktop")).toThrow(/Desktop release build/);
  expect(() => checkAppsTestFlag({ VITE_APPS_TEST: "1", TAURI_ENV_DEBUG: "true", GHOSTLY_BUILD: "abc123" }, "desktop")).toThrow(/image build/);
  expect(checkAppsTestFlag({ ...TAURI_RELEASE_ENV }, "desktop")).toBe(false);
  expect(checkAppsTestFlag({ VITE_APPS_TEST: "", ...TAURI_RELEASE_ENV }, "desktop")).toBe(false);
  expect(() => checkAppsTestFlag({ VITE_APPS_TEST: "1" }, "extension")).toThrow(/extension build/);
  expect(checkAppsTestFlag({}, "extension")).toBe(false);
  // The web app is never inside `tauri build`: Tauri's variables mean nothing to it.
  expect(checkAppsTestFlag({ VITE_APPS_TEST: "1", ...TAURI_RELEASE_ENV }, "web")).toBe(true);
});

it("the guard reads the env the build compiles in, a .env file included", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ghostly-apps-test-"));
  const saved = Object.fromEntries(["VITE_APPS_TEST", "GHOSTLY_BUILD", "TAURI_ENV_DEBUG", ...Object.keys(TAURI_RELEASE_ENV)].map((key) => [key, process.env[key]]));
  for (const key of Object.keys(saved)) delete process.env[key];
  const resolve = (build: AppsTestBuild) => resolveConfig({ root: dir, envDir: dir, configFile: false, logLevel: "silent", plugins: [appsTestGuard(build)] }, "build", "production");
  try {
    await expect(resolve("extension")).resolves.toBeTruthy();
    writeFileSync(join(dir, ".env.production"), "VITE_APPS_TEST=1\n");
    await expect(resolve("extension")).rejects.toThrow(/extension build/);
    await expect(resolve("web")).resolves.toBeTruthy();
    // A release `tauri build`'s hook: Tauri's target variables, no TAURI_ENV_DEBUG.
    Object.assign(process.env, TAURI_RELEASE_ENV);
    await expect(resolve("desktop")).rejects.toThrow(/Desktop release build/);
    process.env.TAURI_ENV_DEBUG = "true";
    await expect(resolve("desktop")).resolves.toBeTruthy();
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
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

const indent = (line: string) => line.length - line.trimStart().length;

/**
 * Where a workflow turns the switch on, in any form: an `env:` key with any value but an empty one (quoted or not, an
 * expression too), or `VITE_APPS_TEST=` with a value in a command. Each comes with the step that holds it, or with no
 * step when it is set for a whole job or workflow (every step under it then has it).
 */
function appsTestSettings(text: string): { line: number; step: string | null }[] {
  const lines = text.split("\n");
  const found: { line: number; step: string | null }[] = [];
  lines.forEach((line, i) => {
    if (line.trimStart().startsWith("#")) return;
    const key = /^\s*VITE_APPS_TEST\s*:\s*(.*?)\s*(#.*)?$/.exec(line);
    const inline = /VITE_APPS_TEST=(?!\s|$|""|'')/.test(line);
    if (!(key && !/^(""|''|)$/.test(key[1])) && !inline) return;
    // Up the parents (each line less indented than the last) to a list item right under `steps:`, if any.
    let step: number | null = null;
    let level = indent(line) + 1;
    for (let j = i; j >= 0 && level > 0; j--) {
      if (!lines[j].trim() || lines[j].trimStart().startsWith("#") || indent(lines[j]) >= level) continue;
      level = indent(lines[j]);
      if (step === null) {
        if (lines[j].trimStart().startsWith("- ")) step = j;
      } else {
        if (!/^\s*steps\s*:/.test(lines[j])) step = null;
        break;
      }
    }
    if (step === null) {
      found.push({ line: i + 1, step: null });
      return;
    }
    let end = step + 1;
    while (end < lines.length && (!lines[end].trim() || indent(lines[end]) > indent(lines[step]))) end++;
    found.push({ line: i + 1, step: lines.slice(step, end).join("\n") });
  });
  return found;
}

/** Why a workflow's switch could reach a build that ships, or null. */
function shippingSwitch(setting: { step: string | null }): string | null {
  if (setting.step === null) return "set for a whole job or workflow";
  if (/build:extension|tauri-action/.test(setting.step)) return "an extension or release Desktop build";
  const desktop = setting.step.split("\n").filter((line) => /\btauri\b.*\bbuild\b/.test(line));
  if (desktop.some((line) => !line.includes("--debug"))) return "a Desktop build without --debug";
  return null;
}

it("the workflow scan finds the switch in every form, and where it is set", () => {
  const job = (body: string) => `on: push\njobs:\n  e2e:\n    runs-on: ubuntu-latest\n${body}`;
  const desktop = (value: string, run = "npm run tauri -- build --debug --no-bundle") =>
    job(`    steps:\n      - uses: actions/checkout@v4\n      - name: Build\n        run: ${run}\n        env:\n          VITE_APPS_TEST: ${value}\n      - name: Next\n        run: echo\n`);
  for (const value of ['"1"', "1", "'1'", "${{ vars.APPS }}", "1 # on"]) {
    const [setting] = appsTestSettings(desktop(value));
    expect(setting.step, value).toMatch(/^ {6}- name: Build\n[\s\S]*VITE_APPS_TEST/);
    expect(setting.step, value).not.toContain("Next");
    expect(shippingSwitch(setting), value).toBeNull();
    expect(shippingSwitch(appsTestSettings(desktop(value, "npm run tauri -- build --no-bundle"))[0]), value).toMatch(/without --debug/);
  }
  for (const value of ['""', "''", ""]) expect(appsTestSettings(desktop(value)), value).toEqual([]);
  // Set for the job or the whole workflow, the switch reaches every step.
  expect(appsTestSettings(job("    env:\n      VITE_APPS_TEST: 1\n    steps:\n      - run: npm run build:extension\n"))).toEqual([{ line: 6, step: null }]);
  expect(appsTestSettings('on: push\nenv:\n  VITE_APPS_TEST: "1"\njobs: {}\n')).toEqual([{ line: 3, step: null }]);
  // In the command itself, or in a step with no `name:`.
  const [inline] = appsTestSettings(job("    steps:\n      - run: VITE_APPS_TEST=1 npm run build:extension\n"));
  expect(shippingSwitch(inline)).toMatch(/extension/);
  const [unnamed] = appsTestSettings(job("    steps:\n      - uses: tauri-apps/tauri-action@v0\n        env:\n          VITE_APPS_TEST: 1\n"));
  expect(shippingSwitch(unnamed)).toMatch(/release Desktop/);
});

it("CI makes a Desktop e2e build with it in debug only, and an extension build never", () => {
  let desktop = 0;
  for (const file of readdirSync(join(ROOT, ".github/workflows")).filter((name) => /\.ya?ml$/.test(name))) {
    for (const setting of appsTestSettings(readFileSync(join(ROOT, ".github/workflows", file), "utf8"))) {
      expect(shippingSwitch(setting), `${file}:${setting.line}`).toBeNull();
      if (/tauri -- build --debug/.test(setting.step ?? "")) desktop++;
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
  // What the build compiles in (Vite's config.env: the shell's VITE_ variables and the .env files' alike).
  const emitted = (env: string | undefined) => {
    const build = process.env.GHOSTLY_BUILD;
    delete process.env.GHOSTLY_BUILD;
    try {
      const files: string[] = [];
      const plugin = runnerHeaders();
      const resolved = plugin.configResolved as unknown as (config: { env: Record<string, string | undefined> }) => void;
      resolved({ env: env === undefined ? {} : { VITE_APPS_TEST: env } });
      const hook = plugin.generateBundle as unknown as (this: { emitFile(file: { fileName: string }): void }) => void;
      hook.call({ emitFile: (file) => files.push(file.fileName) });
      return files;
    } finally {
      if (build !== undefined) process.env.GHOSTLY_BUILD = build;
    }
  };
  expect(emitted(undefined)).toEqual([]);
  expect(emitted("")).toEqual([]);
  expect(emitted("1")).toEqual([UNGUARDED_RUNNER_PATH.slice(1)]);
  expect(existsSync(join(import.meta.dirname, "../../../apps/web/public", UNGUARDED_RUNNER_PATH.slice(1)))).toBe(false);
});

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * android-e2e.yml runs the native Android app's specs. Page code that only the Android app runs (a branch on
 * `androidApp()`, apps/ui/src/desktop/android*.ts) is in its pull request paths, so a change there runs the lane
 * before it merges; the rest of the page and the engine are covered by its nightly run on dev. A new file that
 * branches on `androidApp()` must be added to the paths, or it merges without the lane.
 */
const root = resolve(import.meta.dirname, "../../..");
const text = readFileSync(resolve(root, ".github/workflows/android-e2e.yml"), "utf8");
const on = text.match(/^on:\n((?: {2}.*\n|\n)+)/m)?.[1] ?? "";
const paths = [...(on.match(/^ {4}paths:\n((?: {6}- .*\n)+)/m)?.[1] ?? "").matchAll(/^ {6}- "(.+)"$/gm)].map((m) => m[1]);

/** A workflow `paths` glob as a RegExp: `**` any folders, `*` within one name. */
const glob = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?|\*/g, (m) => (m === "*" ? "[^/]*" : ".*"))}$`);
const covered = (file: string) => paths.some((p) => glob(p).test(file));

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
}

describe("android-e2e.yml", () => {
  it("reads the paths' globs as GitHub does", () => {
    expect(glob("apps/desktop/**").test("apps/desktop/src/lib.rs")).toBe(true);
    expect(glob("apps/ui/src/desktop/android*.ts").test("apps/ui/src/desktop/android.ts")).toBe(true);
    expect(glob("apps/ui/src/desktop/android*.ts").test("apps/ui/src/desktop/androidShare.ts")).toBe(true);
    expect(glob("apps/ui/src/desktop/android*.ts").test("apps/ui/src/desktop/host.ts")).toBe(false);
    expect(glob("apps/ui/src/main.tsx").test("apps/ui/src/mainXtsx")).toBe(false);
  });

  it("runs on pull requests that touch page code only the Android app runs", () => {
    const src = resolve(root, "apps/ui/src");
    const branching = files(src)
      .filter((f) => /\.tsx?$/.test(f) && !relative(src, f).startsWith("test/"))
      .filter((f) => /\bandroidApp\(\)/.test(readFileSync(f, "utf8")))
      .map((f) => relative(root, f));
    expect(branching).toContain("apps/ui/src/components/voice/VoiceRecorderButton.tsx");
    for (const file of [...branching, "apps/ui/src/desktop/android.ts"]) expect(covered(file), `${file} in pull_request.paths`).toBe(true);
    // Not the whole page or the engine on every pull request: the nightly run covers those.
    expect(covered("apps/ui/src/App.tsx")).toBe(false);
    expect(covered("packages/core/src/index.ts")).toBe(false);
  });

  it("runs nightly on dev, on an emulator whose WebView the app takes", () => {
    expect(on).toMatch(/^ {2}schedule:\n {4}- cron: "[\d*/, ]+"$/m);
    // Not API 30: its image's WebView 83 is below the app's minimum (MainActivity.kt MIN_WEBVIEW 111), so the app
    // showed its update screen and every spec failed, every night.
    expect(text).toContain("api-level: [35]");
    expect(text).not.toMatch(/api-level: .*\b30\b/);
    expect(text).toContain("api-level: ${{ matrix.api-level }}");
    // A pull request's run is still cancelled by its next push; a scheduled one never.
    expect(text).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
  });
});

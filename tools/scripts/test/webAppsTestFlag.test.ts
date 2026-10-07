import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { checkAppsTestFlag } from "../../../apps/web/appsTestFlag";

// covers: apps.web-sandbox

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
  for (const file of ["apps/web/src/host.ts", "apps/web/src/main.tsx"]) {
    const text = readFileSync(join(import.meta.dirname, "../../..", file), "utf8");
    for (const line of text.split("\n").filter((l) => l.includes("VITE_APPS_TEST") && !l.trim().startsWith("//"))) expect(line, file).toContain('import.meta.env.VITE_APPS_TEST === "1"');
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

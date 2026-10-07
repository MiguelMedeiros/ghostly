import { readFileSync } from "node:fs";
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
  for (const page of [runner, unguarded]) expect(() => new Function(/<script>([\s\S]*)<\/script>/.exec(page)![1]!)).not.toThrow();
  expect(() => withoutHintGuard("<script></script>")).toThrow(/hint-guard/);
});

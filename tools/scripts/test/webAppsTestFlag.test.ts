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

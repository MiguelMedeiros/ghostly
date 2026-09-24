import { defineConfig } from "vitest/config";

/** The matrix's own logic (generation, constraints), not the scenarios: those run in Playwright. */
export default defineConfig({
  test: { root: import.meta.dirname, include: ["*.test.ts"] },
});

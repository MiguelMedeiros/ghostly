import { defineConfig } from "vitest/config";
import { maxWorkers } from "../../vitest.shared.ts";

/** The matrix's own logic (generation, constraints), not the scenarios: those run in Playwright. */
export default defineConfig({
  test: { root: import.meta.dirname, include: ["*.test.ts"], maxWorkers },
});

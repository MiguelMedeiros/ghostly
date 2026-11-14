import { defineConfig } from "vitest/config";
import { maxWorkers, quarantined } from "../../tools/vitest.shared";

/** The matrix's own logic (generation, constraints), not the scenarios: those run in Playwright. */
export default defineConfig({
  test: { root: import.meta.dirname, include: ["*.test.ts"], exclude: quarantined(undefined, import.meta.dirname), maxWorkers },
});

import { defineConfig } from "vitest/config";
import { maxWorkers } from "../vitest.shared";

/** The repository's own scripts (scripts/test/): what `npm run test:affected` picks, and why. */
export default defineConfig({
  test: { root: import.meta.dirname, include: ["test/**/*.test.ts"], maxWorkers },
});

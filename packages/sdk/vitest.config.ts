import { defineConfig } from "vitest/config";
import { maxWorkers, quarantined, reporters } from "../../tools/vitest.shared.ts";

// The tests need nothing of vite.config.ts (the library build), which this file replaces for Vitest.
export default defineConfig({
  // examples/ is a project of its own, tested against the packed SDK (npm run test:sdk-example).
  test: { maxWorkers, reporters, exclude: quarantined(["examples/**", "**/node_modules/**"]) },
});

import { defineConfig } from "vitest/config";
import { maxWorkers } from "../../vitest.shared";

// The tests need nothing of vite.config.ts (the library build), which this file replaces for Vitest.
export default defineConfig({
  test: { maxWorkers },
});

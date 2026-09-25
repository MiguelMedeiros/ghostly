import { defineConfig } from "vitest/config";
import { maxWorkers } from "../../vitest.shared.ts";

export default defineConfig({
  test: { maxWorkers },
});

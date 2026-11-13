import { defineConfig } from "vitest/config";
import { maxWorkers, reporters } from "../../tools/vitest.shared.ts";

export default defineConfig({
  test: { maxWorkers, reporters },
});

import { defineConfig } from "vitest/config";
import { maxWorkers, quarantined, reporters } from "../../tools/vitest.shared.ts";

export default defineConfig({
  test: { maxWorkers, reporters, exclude: quarantined() },
});

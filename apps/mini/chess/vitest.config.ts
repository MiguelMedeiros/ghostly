import { defineConfig } from "vitest/config";
import { maxWorkers, quarantined } from "../../../tools/vitest.shared.ts";

export default defineConfig({
  test: { maxWorkers, include: ["test/**/*.test.ts"], exclude: quarantined() },
});

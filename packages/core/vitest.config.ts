import { defineConfig } from "vitest/config";
import { maxWorkers } from "../../vitest.shared";

export default defineConfig({
  test: { maxWorkers },
});

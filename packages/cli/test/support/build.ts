import { resolve } from "node:path";
import { build } from "vite";

/** The binary tests run the CLI as users do: built once, before them. */
export default async function setup(): Promise<void> {
  const root = resolve(import.meta.dirname, "../..");
  await build({ root, configFile: resolve(root, "vite.config.ts"), logLevel: "warn" });
}

import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { ghostlyPlatformModules, repositoryRoot, tauriAliases } from "../packages/browser/vite-plugin";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [ghostlyPlatformModules(), react(), tailwindcss()],
  envDir: repositoryRoot,
  resolve: { alias: tauriAliases },
  server: { port: 5180, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
});

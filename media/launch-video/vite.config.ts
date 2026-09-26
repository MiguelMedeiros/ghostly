import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { ghostlyPlatformModules, repositoryRoot, tauriAliases } from "../../packages/browser/vite-plugin";

// The film page (film/) runs the app's own components against the test engine, as web/ runs the app.
const here = dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  root: resolve(here, "film"),
  define: { __APP_VERSION__: JSON.stringify("1.0.0"), __APP_BUILD__: JSON.stringify("film") },
  plugins: [ghostlyPlatformModules(), react(), tailwindcss()],
  envDir: repositoryRoot,
  resolve: { alias: tauriAliases },
  server: { port: Number(process.env.FILM_PORT ?? 5391), strictPort: true, fs: { allow: [repositoryRoot] } },
  logLevel: "warn",
});

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The film page (film/): plain React and SVG, drawn from the film's time.
const here = dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  root: resolve(here, "film"),
  plugins: [react()],
  server: { port: Number(process.env.FILM_PORT ?? 5393), strictPort: true, fs: { allow: [resolve(here, "../..")] } },
  logLevel: "warn",
});

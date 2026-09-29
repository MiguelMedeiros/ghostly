import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { ghostlyPlatformModules } from "./packages/browser/vite-plugin";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  // Desktop runs the shared peer too: the modules that used to call into Rust
  // for chat are swapped for the ones backed by it, as in the browser clients.
  plugins: [ghostlyPlatformModules(), react(), tailwindcss()],
  // Desktop's Iroh is native: the browser build of it stays out of the app.
  resolve: { alias: { "@ghostly/iroh-web": fileURLToPath(new URL("./src/desktop/noIrohWeb.ts", import.meta.url)) } },
  clearScreen: false,
  server: {
    host: host || "localhost",
    port: 5173,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
});

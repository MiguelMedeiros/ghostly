import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { ghostlyPlatformModules, repositoryRoot, tauriAliases } from "../../packages/browser/vite-plugin";
import { appsTestGuard } from "../web/appsTestFlag";
import { translateGuard } from "../web/translateFlag";

export default defineConfig(({ mode }) => ({
  // The extension has no e2e build with mini-apps, and no translation: it never carries their switches (VITE_APPS_TEST,
  // VITE_TRANSLATE).
  plugins: [appsTestGuard("extension"), translateGuard("extension"), ghostlyPlatformModules(), react(), tailwindcss()],
  base: "",
  envDir: repositoryRoot,
  resolve: { alias: tauriAliases },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: mode === "development",
    minify: mode !== "development",
    // Extension pages must not inline scripts (MV3 CSP), and the service
    // worker needs a stable file name for the manifest.
    modulePreload: false,
    rollupOptions: {
      input: {
        app: resolve(__dirname, "app.html"),
        offscreen: resolve(__dirname, "offscreen.html"),
        background: resolve(__dirname, "src/background.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
}));

import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const desktop = (path: string) => resolve(__dirname, "../src", path);
const platform = (path: string) => resolve(__dirname, "src/platform", path);

/**
 * Ghostly Browser builds the Desktop UI (`../src`) unchanged. These are the
 * only Desktop modules that touch the platform, each swapped for a stand-in
 * with the same exports.
 */
const PLATFORM_MODULES = new Map([
  [desktop("lib/pkarr.ts"), platform("pkarr.ts")],
  [desktop("lib/crypto.ts"), platform("crypto.ts")],
  [desktop("lib/platform.ts"), platform("services.ts")],
  [desktop("hooks/useChat.ts"), platform("useChat.ts")],
  [desktop("hooks/useBackgroundPoller.ts"), platform("useBackgroundPoller.ts")],
]);

function platformModules(): Plugin {
  return {
    name: "ghostly-platform-modules",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer || importer.startsWith(platform(""))) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return (resolved && PLATFORM_MODULES.get(resolved.id)) ?? null;
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [platformModules(), react(), tailwindcss()],
  base: "",
  // One `.env` for both clients (VITE_GIPHY_API_KEY).
  envDir: resolve(__dirname, ".."),
  resolve: {
    alias: {
      "@tauri-apps/api/core": platform("tauri.ts"),
      "@tauri-apps/api/app": platform("tauri.ts"),
    },
  },
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

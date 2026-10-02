import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { serviceWorker } from "./pwa";
import { ghostlyPlatformModules, repositoryRoot, tauriAliases } from "../../packages/browser/vite-plugin";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

/**
 * Which build this is. The deployed app follows `main`, so the version alone
 * does not say whether a tab is running what the server now serves; the commit
 * does. The image build passes it in (there is no git there).
 */
function buildId(): string {
  if (process.env.GHOSTLY_BUILD) return process.env.GHOSTLY_BUILD.slice(0, 12);
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "dev";
  }
}

const build = buildId();

/**
 * `/version.json` is what a running tab asks to find out that it is out of
 * date. nginx serves everything outside `/assets/` with `no-cache`, so the
 * answer is always the deployed one.
 */
function versionFile(): Plugin {
  const body = JSON.stringify({ version, build }) + "\n";
  return {
    name: "ghostly-version-file",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "version.json", source: body });
    },
    // The same two facts in the page itself, for the boot guard's "Copy details" (public/boot-guard.js): it runs
    // where the bundle may not, so it cannot be handed them in code.
    transformIndexHtml(html, context) {
      if (!context.path.endsWith("index.html")) return html;
      return { html, tags: [{ tag: "meta", attrs: { name: "ghostly-build", content: `${version} ${build}` }, injectTo: "head" }] };
    },
    configureServer(server) {
      server.middlewares.use("/version.json", (_request, response) => {
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Cache-Control", "no-store");
        response.end(body);
      });
    },
  };
}

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version), __APP_BUILD__: JSON.stringify(build) },
  plugins: [versionFile(), serviceWorker(build), ghostlyPlatformModules(), react(), tailwindcss()],
  envDir: repositoryRoot,
  resolve: { alias: tauriAliases },
  server: { port: 5180, strictPort: true },
  // The e2e suites serve the build with `vite preview`. Left to "localhost", Node listens on the first address the
  // name resolves to, ::1 on macOS and on GitHub's Ubuntu, and 127.0.0.1 is refused: the Bluesky specs must open the
  // app there (AT Protocol's development client returns only to 127.0.0.1). http://localhost still reaches it.
  preview: { host: "127.0.0.1" },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The static page a provider returns to after an identity-proof sign-in (proofs/oidc/popup.ts).
    rollupOptions: { input: { main: "index.html", oidcCallback: "oidc-callback.html" } },
  },
});

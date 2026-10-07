import { readFileSync } from "node:fs";
import type { Plugin } from "vite";
import { checkAppsTestFlag } from "./appsTestFlag";

/** Where the mini-app runner is served (public/app-frame.html; WISP 1200, "The runner and the broker"). */
export const RUNNER_PATH = "/app-frame.html";

/**
 * The runner without its hint guard, in the e2e suite's build only (VITE_APPS_TEST): the nonce lock measured alone,
 * since the guard would keep the probes' frames out before the lock is reached. Never in a release build.
 */
export const UNGUARDED_RUNNER_PATH = "/app-frame-unguarded.html";

const GUARD = /\n {2}\/\/ ghostly:hint-guard:start\n[\s\S]*?\n {2}\/\/ ghostly:hint-guard:end\n/;

/** The runner's markup with the guard block taken out (`hintGuard` is then null). */
export function withoutHintGuard(runner: string): string {
  if (!GUARD.test(runner)) throw new Error("app-frame.html: no ghostly:hint-guard block");
  return runner.replace(GUARD, "\n  const hintGuard = null;\n");
}

/**
 * The runner's policy (WISP 1200, "The runner's CSP"), sent as an HTTP header so `sandbox` holds even when the page is
 * opened directly. The same text is in nginx.conf's runner location, and in apps/desktop/src/app_sandbox.rs for
 * Desktop's `ghostly-app` scheme (contentSecurityPolicy.test.ts keeps the three the same).
 */
export const RUNNER_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; " +
  "img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; " +
  "form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

/**
 * Where an app the person granted `internet` runs (WISP 1200 · Permissions): the same runner, with a policy that lets
 * it reach HTTPS and WSS servers (fetch, WebSocket, images, media, fonts). Everything else stays shut: still sandboxed,
 * no script from anywhere but the entry, no frames, forms, workers or top navigation, WebRTC still deleted.
 */
export const NET_RUNNER_PATH = "/app-frame-net.html";

export const NET_RUNNER_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; " +
  "img-src data: blob: https:; media-src data: blob: https:; font-src data: https:; connect-src https: wss:; frame-src 'none'; " +
  "worker-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

/** What the runner's location sends: its own policy, and the headers every other location sends (not the page's policy). */
export const RUNNER_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": RUNNER_CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  // A header, not a <meta>: the runner's own head is gone once it writes the app's entry.
  "X-DNS-Prefetch-Control": "off",
  "Cache-Control": "no-cache",
};

/** The network runner's: the same, with its own policy. */
export const NET_RUNNER_HEADERS: Readonly<Record<string, string>> = { ...RUNNER_HEADERS, "Content-Security-Policy": NET_RUNNER_CSP };

/**
 * The runner's headers from Vite's own servers too: `vite preview` serves the build the e2e suites test, and sends no
 * header of its own, so without this every app would refuse to start there (the runner checks its opaque origin).
 */
export function runnerHeaders(): Plugin {
  const add = (request: { url?: string }, response: { setHeader(name: string, value: string): unknown }, next: () => void) => {
    const path = request.url?.split(/[?#]/)[0];
    // Both runners get the header; the unguarded one exists only in an e2e build (a 404 elsewhere).
    if (path === RUNNER_PATH || path === UNGUARDED_RUNNER_PATH) for (const [name, value] of Object.entries(RUNNER_HEADERS)) response.setHeader(name, value);
    // The network runner is the same file under its own policy (nginx.conf does the same).
    if (path === NET_RUNNER_PATH) {
      for (const [name, value] of Object.entries(NET_RUNNER_HEADERS)) response.setHeader(name, value);
      request.url = RUNNER_PATH;
    }
    next();
  };
  return {
    name: "ghostly-runner-headers",
    generateBundle() {
      if (!checkAppsTestFlag()) return;
      const runner = readFileSync(new URL("./public/app-frame.html", import.meta.url), "utf8");
      this.emitFile({ type: "asset", fileName: UNGUARDED_RUNNER_PATH.slice(1), source: withoutHintGuard(runner) });
    },
    configureServer(server) { server.middlewares.use(add); },
    configurePreviewServer(server) { server.middlewares.use(add); },
  };
}

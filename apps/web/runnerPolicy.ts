import type { Plugin } from "vite";

/** Where the mini-app runner is served (public/app-frame.html; WISP 1200, "The runner and the broker"). */
export const RUNNER_PATH = "/app-frame.html";

/**
 * The runner's policy (WISP 1200, "The runner's CSP"), sent as an HTTP header so `sandbox` holds even when the page is
 * opened directly. The same text is in nginx.conf's runner location, and in apps/desktop/src/app_sandbox.rs for
 * Desktop's `ghostly-app` scheme (contentSecurityPolicy.test.ts keeps the three the same).
 */
export const RUNNER_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; " +
  "img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; " +
  "form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

/** What the runner's location sends: its own policy, and the headers every other location sends (not the page's policy). */
export const RUNNER_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": RUNNER_CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cache-Control": "no-cache",
};

/**
 * The runner's headers from Vite's own servers too: `vite preview` serves the build the e2e suites test, and sends no
 * header of its own, so without this every app would refuse to start there (the runner checks its opaque origin).
 */
export function runnerHeaders(): Plugin {
  const add = (request: { url?: string }, response: { setHeader(name: string, value: string): unknown }, next: () => void) => {
    if (request.url?.split(/[?#]/)[0] === RUNNER_PATH) for (const [name, value] of Object.entries(RUNNER_HEADERS)) response.setHeader(name, value);
    next();
  };
  return {
    name: "ghostly-runner-headers",
    configureServer(server) { server.middlewares.use(add); },
    configurePreviewServer(server) { server.middlewares.use(add); },
  };
}

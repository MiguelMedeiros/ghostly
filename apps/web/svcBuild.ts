import { fileURLToPath } from "node:url";
import { build, type Plugin } from "vite";
import { BRIDGE_PAGE, BRIDGE_SCRIPT, WORKER_SCRIPT, parseServicesHost } from "./src/svc/protocol";

const WORKER_ENTRY = fileURLToPath(new URL("./src/svc/worker.ts", import.meta.url));
const BRIDGE_ENTRY = fileURLToPath(new URL("./src/svc/bridge.ts", import.meta.url));

/**
 * The page a contact's app origin starts from: the bridge's script and a frame for the app, nothing else. Its
 * policy is the server's (nginx.conf's services server); this one holds where none is sent (`vite preview`).
 */
export function bridgeHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; frame-src 'self'">
<meta name="referrer" content="no-referrer">
<title>Ghostly</title>
<style>html,body{margin:0;height:100%;background:#fff;font:14px system-ui,sans-serif}iframe{border:0;width:100%;height:100%;display:block}body>p{padding:16px}</style>
</head><body><script src="${BRIDGE_SCRIPT}"></script></body></html>
`;
}

/** One script on its own: a classic one with nothing to import, as a worker and a plain `<script src>` need. */
async function script(entry: string, define: Record<string, string>): Promise<string> {
  const output = await build({
    configFile: false,
    logLevel: "warn",
    define,
    build: { write: false, emptyOutDir: false, minify: true, lib: { entry, formats: ["iife"], name: "ghostlyServices", fileName: () => "out.js" } },
  });
  const chunk = (Array.isArray(output) ? output : [output]).flatMap((o) => ("output" in o ? o.output : [])).find((o) => o.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error(`${entry} did not build`);
  return chunk.code;
}

/**
 * Opening a contact's shared app on the web (src/svc/): the services worker, the bridge's page and its script, built
 * when the build is given a services host (`VITE_SERVICES_HOST`, e.g. `https://*.svc.example`) and the app's own
 * origin (`VITE_SERVICES_APP_ORIGIN`), the only page that may hand the bridge its port. Without both, nothing is
 * emitted and the web app opens no contact's app, as before.
 */
export function servicesBridge(): Plugin {
  // As the app reads them (`import.meta.env`): the environment, or a .env file at the root.
  let env: Record<string, string | undefined> = {};
  return {
    name: "ghostly-services-bridge",
    apply: "build",
    configResolved(config) { env = config.env; },
    async generateBundle() {
      const host = env.VITE_SERVICES_HOST ?? "";
      const appOrigin = env.VITE_SERVICES_APP_ORIGIN ?? "";
      if (!host && !appOrigin) return;
      if (!parseServicesHost(host)) throw new Error(`VITE_SERVICES_HOST is not a services host (https://*.example): ${JSON.stringify(host)}`);
      if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/.test(appOrigin)) throw new Error(`VITE_SERVICES_APP_ORIGIN is not an origin: ${JSON.stringify(appOrigin)}`);
      const define = { __SERVICES_HOST__: JSON.stringify(host), __SERVICES_APP_ORIGIN__: JSON.stringify(appOrigin) };
      this.emitFile({ type: "asset", fileName: WORKER_SCRIPT.slice(1), source: await script(WORKER_ENTRY, define) });
      this.emitFile({ type: "asset", fileName: BRIDGE_SCRIPT.slice(1), source: await script(BRIDGE_ENTRY, define) });
      this.emitFile({ type: "asset", fileName: BRIDGE_PAGE.slice(1), source: bridgeHtml() });
    },
  };
}

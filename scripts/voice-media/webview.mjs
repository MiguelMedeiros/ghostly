import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Runs a function in the macOS system WKWebView (`webview.swift`), the engine Ghostly Desktop uses on a Mac,
 * which no WebDriver can reach. `fn` is sent as source and called with `args`; what it resolves comes back.
 * `csp` is applied as the page's policy, with only the page's own inline script let in by its hash.
 */
const here = import.meta.dirname;
const work = mkdtempSync(join(tmpdir(), "ghostly-webview-"));
let binary = null;

function build() {
  if (binary) return binary;
  binary = join(work, "webview");
  execFileSync("swiftc", ["-O", join(here, "webview.swift"), "-o", binary], { stdio: "inherit" });
  return binary;
}

export function inWebView(fn, args, { csp } = {}) {
  const script = `(${String(fn)})(...${JSON.stringify(args)}).then((value) => window.webkit.messageHandlers.done.postMessage(JSON.stringify({ value })), (error) => window.webkit.messageHandlers.done.postMessage(JSON.stringify({ error: String(error) })));`;
  const hash = createHash("sha256").update(script).digest("base64");
  const policy = csp && csp.replace(/script-src ([^;]*)/, `script-src $1 'sha256-${hash}'`);
  const page = join(work, `page-${Date.now()}.html`);
  writeFileSync(page, `<!doctype html><html><head>${policy ? `<meta http-equiv="Content-Security-Policy" content="${policy}">` : ""}</head><body><script>${script}</script></body></html>`);
  const output = execFileSync(build(), [page], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const parsed = JSON.parse(output.trim().split("\n").pop());
  if (parsed.error) throw new Error(`WKWebView: ${parsed.error}`);
  return parsed.value;
}

/** Ghostly Desktop's policy, as `src-tauri/tauri.conf.json` ships it. */
export function desktopPolicy() {
  return JSON.parse(readFileSync(join(here, "../../src-tauri/tauri.conf.json"), "utf8")).app.security.csp;
}

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DesktopApp } from "./desktop";

/**
 * Ghostly Desktop on a Mac, driven without a WebDriver (WKWebView has none).
 *
 * The app is built once with the test driver compiled in (`src-tauri/src/e2e_driver.rs`, debug builds with
 * `--features e2e-driver` only), then copied once per person with a bundle id of its own: WebKit keeps a
 * page's storage per bundle id, so two copies are two apps with nothing in common, like two Macs. Each copy
 * is started with `GHOSTLY_E2E_DRIVER=<port>`, and the driver runs scripts in its windows. Everything below
 * — a click, typing, reading text — is a script in the page, as WebDriver's `execute` would run it.
 *
 *   npm run desktop:macos:build
 *   npm run test:e2e:desktop-macos
 *
 * The copies stay out of the Dock and never take the focus (the driver sets that), read an empty clipboard,
 * and are removed with their WebKit data when they stop. See e2e/README.md → "Desktop on macOS".
 */

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

/** The bundle ids of the copies begin with this; nothing else is ever removed from ~/Library. */
export const BUNDLE_PREFIX = "tools.ghostly.e2e.";

/** The app `npm run desktop:macos:build` makes, or `GHOSTLY_DESKTOP_APP`. */
export function macBundle(): string {
  const path = resolve(process.env.GHOSTLY_DESKTOP_APP ?? join(repositoryRoot, "target", "debug", "bundle", "macos", "Ghostly.app"));
  if (!existsSync(path)) {
    throw new Error(`No Desktop app at ${path}. Build one with the test driver first:\n  npm run desktop:macos:build\nor point GHOSTLY_DESKTOP_APP at one.`);
  }
  return path;
}

/** Where WebKit and macOS keep what an app with this bundle id wrote. */
function libraryPaths(bundleId: string): string[] {
  const library = join(homedir(), "Library");
  return [
    join(library, "WebKit", bundleId),
    join(library, "Caches", bundleId),
    join(library, "HTTPStorages", bundleId),
    join(library, "HTTPStorages", `${bundleId}.binarycookies`),
    join(library, "Application Support", bundleId),
    join(library, "Preferences", `${bundleId}.plist`),
    join(library, "Saved Application State", `${bundleId}.savedState`),
  ];
}

/**
 * What the copies share: the app's log and its files go by the identifier it was built with
 * (src-tauri/tauri.e2e.conf.json), files in a folder per GHOSTLY_PROFILE. Removed before the apps start and after
 * they all stopped, never while one runs.
 */
export function forgetSharedData(): void {
  const build = BUNDLE_PREFIX.slice(0, -1);
  for (const path of [join(homedir(), "Library", "Logs", build), join(homedir(), "Library", "Application Support", build)]) {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

function forget(bundleId: string): void {
  if (!bundleId.startsWith(BUNDLE_PREFIX)) throw new Error(`Not a test bundle id: ${bundleId}`);
  for (const path of libraryPaths(bundleId)) rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/** A copy of the app with a bundle id of its own, ad-hoc signed again (its Info.plist changed). */
function copyApp(source: string, name: string): { app: string; bundleId: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `ghostly-mac-${name}-`));
  const app = join(dir, `Ghostly-${name}.app`);
  const bundleId = `${BUNDLE_PREFIX}${name}`;
  execFileSync("ditto", [source, app]);
  execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :CFBundleIdentifier ${bundleId}`, join(app, "Contents", "Info.plist")]);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "ignore" });
  const remove = () => {
    // The app registers itself with Launch Services to post notifications (src-tauri/src/notifications.rs):
    // forgotten with the copy, so no record points at a folder that is gone.
    try { execFileSync(LSREGISTER, ["-u", app], { stdio: "ignore" }); } catch { /* never registered */ }
    rmSync(dir, { recursive: true, force: true });
  };
  return { app, bundleId, remove };
}

/** Wraps a function body (`arguments[0]`… are `args`) so the page answers with JSON, or with what it threw. */
const syncScript = (body: string, args: unknown[]) =>
  `(() => { try { const value = (function () { ${body}\n }).apply(null, ${JSON.stringify(args)});
    return JSON.stringify({ ok: true, value: value === undefined ? null : value }); }
  catch (error) { return JSON.stringify({ ok: false, error: (error && error.message ? error.name + ": " + error.message : String(error)) }); } })()`;

/** One app's driver: scripts in its windows, by label (`main` is Ghostly's own). */
export class MacDriver implements DesktopApp {
  private asyncIds = 0;
  private readonly endpoint: string;
  private readonly token: string;
  readonly window: string;

  constructor(endpoint: string, token: string, window = "main") {
    this.endpoint = endpoint;
    this.token = token;
    this.window = window;
  }

  /** The same app's driver, in another of its windows (a contact's app opens in one). */
  in(window: string): MacDriver {
    return new MacDriver(this.endpoint, this.token, window);
  }

  async windows(): Promise<string[]> {
    return (await this.request("GET", "/windows")) as string[];
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${this.endpoint}${path}`, {
      method,
      headers: { "x-ghostly-e2e": this.token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = (await response.json()) as unknown;
    if (!response.ok) throw new Error(`${method} ${path}: ${(payload as { error?: string }).error ?? response.status}`);
    return payload;
  }

  async execute<T = unknown>(script: string, ...args: unknown[]): Promise<T> {
    const raw = await this.request("POST", "/eval", { window: this.window, script: syncScript(script, args) });
    if (typeof raw !== "string") throw new Error(`The page gave no answer (${JSON.stringify(raw)}): is it still loading, or is the script not valid JavaScript?`);
    const answer = JSON.parse(raw) as { ok: boolean; value?: T; error?: string };
    if (!answer.ok) throw new Error(answer.error);
    return answer.value as T;
  }

  /** As `execute`, for a body that calls `arguments[arguments.length - 1]` with its result later. */
  async executeAsync<T = unknown>(script: string, ...args: unknown[]): Promise<T> {
    const id = `a${++this.asyncIds}`;
    // The body goes into the source, not through `new Function`: the page's policy has no 'unsafe-eval'.
    await this.execute(
      `const [id, args] = arguments;
       const results = (window.__e2eAsync ??= {});
       const done = (value) => { results[id] = { ok: true, value: value === undefined ? null : value }; };
       try { (function () { ${script}\n }).apply(null, [...args, done]); }
       catch (error) { results[id] = { ok: false, error: (error && error.message ? error.name + ": " + error.message : String(error)) }; }`,
      id, args,
    );
    const deadline = Date.now() + 120_000;
    for (;;) {
      const result = await this.execute<{ ok: boolean; value?: T; error?: string } | null>(
        `const r = window.__e2eAsync?.[arguments[0]] ?? null; if (r) delete window.__e2eAsync[arguments[0]]; return r;`, id);
      if (result) {
        if (!result.ok) throw new Error(result.error);
        return result.value as T;
      }
      if (Date.now() > deadline) throw new Error("The page's async script never finished");
      await new Promise((done) => setTimeout(done, 100));
    }
  }

  text(selector: string): Promise<string | null> {
    return this.execute(`const e = document.querySelector(arguments[0]); return e ? e.innerText : null;`, selector);
  }

  attribute(selector: string, name: string): Promise<string | null> {
    return this.execute(`const e = document.querySelector(arguments[0]); return e ? e.getAttribute(arguments[1]) : null;`, selector, name);
  }

  title(): Promise<string> {
    return this.execute(`return document.title;`);
  }

  /**
   * Waits for a match, as a Playwright click does: the page draws what an action asks for a moment after it
   * (a hash change, a dialog), and a click or keys sent before would be lost. Throws after `timeout`.
   */
  private async present(selector: string, timeout = 10_000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (!(await this.execute<boolean>(`return !!document.querySelector(arguments[0]);`, selector))) {
      if (Date.now() > deadline) return;
      await new Promise((done) => setTimeout(done, 100));
    }
  }

  /** The pointer's events on the element, then its click: what a press sends, where it lands. */
  async click(selector: string): Promise<void> {
    await this.present(selector);
    await this.execute(
      `const e = document.querySelector(arguments[0]);
       if (!e) throw new Error("Nothing to click at " + arguments[0]);
       e.scrollIntoView({ block: "center" });
       const init = { bubbles: true, cancelable: true, composed: true, button: 0, pointerType: "mouse", isPrimary: true };
       e.dispatchEvent(new PointerEvent("pointerdown", init)); e.dispatchEvent(new MouseEvent("mousedown", init));
       if (typeof e.focus === "function") e.focus();
       e.dispatchEvent(new PointerEvent("pointerup", init)); e.dispatchEvent(new MouseEvent("mouseup", init));
       e.click();`,
      selector,
    );
  }

  /**
   * Types into the first match. React reads a field's value through its own setter, so the text is set with the
   * native one and announced with an `input` event. `` (WebDriver's Enter) is a key press.
   */
  async type(selector: string, text: string): Promise<void> {
    await this.present(selector);
    await this.execute(
      `const [selector, text] = arguments;
       const e = document.querySelector(selector);
       if (!e) throw new Error("Nothing to type into at " + selector);
       e.focus();
       const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
       const set = Object.getOwnPropertyDescriptor(proto, "value").set;
       for (const part of text.split(/(\\uE007)/)) {
         if (part === "\\uE007") {
           const key = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
           const go = e.dispatchEvent(new KeyboardEvent("keydown", key));
           e.dispatchEvent(new KeyboardEvent("keypress", key));
           e.dispatchEvent(new KeyboardEvent("keyup", key));
           if (go && e instanceof HTMLInputElement && e.form) e.form.requestSubmit();
         } else if (part) {
           set.call(e, e.value + part);
           e.dispatchEvent(new InputEvent("input", { bubbles: true, data: part, inputType: "insertText" }));
         }
       }`,
      selector, text,
    );
  }
}

export interface MacDesktopOptions {
  /** Names the copy (its bundle id is `tools.ghostly.e2e.<name>`) and, unless `profile` says otherwise, its GHOSTLY_PROFILE. */
  name: string;
  profile?: string;
  /** The driver's port on 127.0.0.1. */
  port: number;
  env?: Record<string, string>;
}

export interface MacDesktop {
  app: MacDriver;
  bundleId: string;
  /** Where the copy is (a temporary folder). */
  bundle: string;
  /** What the app printed, for the report when something fails. */
  log: string[];
  /** Quits the app. `keep` leaves its data, for opening the same copy again with `open`. */
  stop(options?: { keep?: boolean }): Promise<void>;
}

/** Copies, starts and waits for one app; `stop` quits it and removes the copy and everything it stored. */
export async function openMacDesktop(options: MacDesktopOptions): Promise<MacDesktop> {
  if (process.platform !== "darwin") throw new Error("openMacDesktop runs on macOS only");
  const source = macBundle();
  const copy = copyApp(source, options.name);
  // A fresh app: nothing left from an earlier run that stopped halfway.
  forget(copy.bundleId);
  const executable = join(copy.app, "Contents", "MacOS", readdirSync(join(copy.app, "Contents", "MacOS"))[0]);
  const token = randomBytes(16).toString("hex");
  const log: string[] = [];
  const child: ChildProcess = spawn(executable, [], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GHOSTLY_PROFILE: options.profile ?? `e2e-${options.name}`,
      GHOSTLY_E2E_DRIVER: String(options.port),
      GHOSTLY_E2E_DRIVER_TOKEN: token,
      ...options.env,
    },
  });
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
  let exited: number | null | undefined;
  const gone = new Promise<void>((done) => child.on("exit", (code) => { exited = code; done(); }));

  const cleanup = async ({ keep = false } = {}) => {
    if (exited === undefined) {
      child.kill("SIGTERM");
      await Promise.race([gone, new Promise((done) => setTimeout(done, 5_000))]);
      if (exited === undefined) { child.kill("SIGKILL"); await gone; }
    }
    if (!keep) { forget(copy.bundleId); copy.remove(); }
  };

  const app = new MacDriver(`http://127.0.0.1:${options.port}`, token);
  try {
    // The driver listens as soon as the app is set up; the page answers once it has loaded.
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (exited !== undefined) throw new Error(`The app exited (${exited}) before it could be driven:\n${log.join("")}`);
      try {
        if ((await app.execute<string>(`return document.readyState;`)) === "complete") break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
      }
      await new Promise((done) => setTimeout(done, 250));
    }
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { app, bundleId: copy.bundleId, bundle: copy.app, log, stop: cleanup };
}

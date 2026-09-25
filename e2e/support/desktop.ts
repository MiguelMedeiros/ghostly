import { test as base, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export { expect };

/**
 * Ghostly Desktop, driven through WebDriver.
 *
 * The other projects drive a browser; there is no browser here. `tauri-driver`
 * launches the real bundled binary — the same one a release ships — and hands
 * the WebView to the platform's WebDriver (`WebKitWebDriver` on Linux,
 * `msedgedriver` on Windows). Nothing is added to the app to make this work,
 * so what the test drives is what people install.
 *
 * WebDriver is a small JSON-over-HTTP protocol, so it is spoken here directly
 * rather than through a second test runner: Playwright stays the only one.
 *
 * macOS cannot run this: WKWebView has no WebDriver. See e2e/README.md.
 */

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

/** The W3C key an element reference hides behind. */
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";

/**
 * The Desktop binary to drive: whichever of the two profiles was built last,
 * so a debug build after a release one is not quietly ignored.
 *
 * It has to come from `tauri build`, not `cargo build`: a plain cargo debug
 * build points the WebView at the dev server (`devUrl`), and with no dev server
 * running the window only says "Connection refused".
 */
export function desktopBinary(): string {
  const fromEnv = process.env.GHOSTLY_DESKTOP_BINARY;
  if (fromEnv) return resolve(fromEnv);
  const name = process.platform === "win32" ? "ghostly.exe" : "ghostly";
  const built = ["debug", "release"]
    .map((profile) => resolve(repositoryRoot, "target", profile, name))
    .filter((path) => existsSync(path))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (built.length > 0) return built[0];
  throw new Error(
    `No Desktop binary at target/{debug,release}/${name}. Build one first:\n` +
      "  npm run tauri -- build --debug --no-bundle\n" +
      "or point GHOSTLY_DESKTOP_BINARY at one.",
  );
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

/** One conversation with the driver. Errors carry what the driver said, not "500". */
class Driver {
  constructor(
    private readonly endpoint: string,
    private readonly sessionId: string,
  ) {}

  static async open(endpoint: string, application: string): Promise<Driver> {
    const value = (await Driver.send(`${endpoint}/session`, "POST", {
      capabilities: { alwaysMatch: { browserName: "wry", "tauri:options": { application } } },
    })) as { sessionId: string };
    return new Driver(endpoint, value.sessionId);
  }

  private static async send(url: string, method: string, body?: unknown): Promise<unknown> {
    const response = await fetch(url, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let payload: { value?: unknown };
    try {
      payload = JSON.parse(text) as { value?: unknown };
    } catch {
      throw new Error(`${method} ${url}: ${response.status} ${text.slice(0, 200)}`);
    }
    if (!response.ok) {
      const failure = payload.value as { error?: string; message?: string } | undefined;
      const error = new Error(failure?.message ?? failure?.error ?? `${method} ${url}: ${response.status}`);
      error.name = failure?.error ?? "webdriver error";
      throw error;
    }
    return payload.value;
  }

  private call(method: string, path: string, body?: unknown): Promise<unknown> {
    return Driver.send(`${this.endpoint}/session/${this.sessionId}${path}`, method, body);
  }

  /** The element reference, or null when nothing matches — the wait belongs to the test. */
  private async find(selector: string): Promise<string | null> {
    try {
      const value = (await this.call("POST", "/element", { using: "css selector", value: selector })) as Record<string, string>;
      return value[ELEMENT] ?? null;
    } catch (error) {
      if (error instanceof Error && error.name === "no such element") return null;
      throw error;
    }
  }

  /** The visible text of the first match, or null when there is no match yet. */
  async text(selector: string): Promise<string | null> {
    const element = await this.find(selector);
    return element === null ? null : ((await this.call("GET", `/element/${element}/text`)) as string);
  }

  /** An attribute of the first match, or null when there is no match (or no such attribute) yet. */
  async attribute(selector: string, name: string): Promise<string | null> {
    const element = await this.find(selector);
    return element === null ? null : ((await this.call("GET", `/element/${element}/attribute/${name}`)) as string | null);
  }

  /**
   * Types into the first match, as keys: React sees each one. `\uE007` is Enter. Throws when nothing
   * matches, like a click.
   */
  async type(selector: string, text: string): Promise<void> {
    const element = await this.find(selector);
    if (element === null) throw new Error(`Nothing to type into at ${selector}`);
    await this.call("POST", `/element/${element}/value`, { text });
  }

  /** Runs a function body in the page (`arguments[0]`… are `args`) and returns what it returns. */
  async execute<T = unknown>(script: string, ...args: unknown[]): Promise<T> {
    return (await this.call("POST", "/execute/sync", { script, args })) as T;
  }

  /** Throws when nothing matches: a click is not something to be vague about. */
  async click(selector: string): Promise<void> {
    const element = await this.find(selector);
    if (element === null) throw new Error(`Nothing to click at ${selector}`);
    await this.call("POST", `/element/${element}/click`, {});
  }

  async title(): Promise<string> {
    return (await this.call("GET", "/title")) as string;
  }

  async close(): Promise<void> {
    await this.call("DELETE", "").catch(() => {});
  }
}

export type DesktopApp = Pick<Driver, "text" | "click" | "title" | "attribute" | "type" | "execute">;

export interface DesktopOptions {
  /** `GHOSTLY_PROFILE`: the app's own space in its storage. */
  profile?: string;
  /**
   * A home of its own (HOME and the XDG directories): the WebView's storage, the app's data. Two apps on one
   * machine need one each, or they share one WebKit store. Kept between two opens with the same directory,
   * which is how a test closes an app and opens it again.
   */
  home?: string;
  /** More environment for the app, e.g. `GHOSTLY_PKARR_RELAYS` or `GHOSTLY_HYPERDHT_BOOTSTRAP`. */
  env?: Record<string, string>;
}

/** A directory for `DesktopOptions.home`, removed by the returned function. */
export function desktopHome(name: string): { dir: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `ghostly-desktop-${name}-`));
  // The app may still be writing its store for a moment after it closed.
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) };
}

const homeEnv = (dir: string): Record<string, string> => {
  const env = { HOME: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CONFIG_HOME: join(dir, "config"), XDG_CACHE_HOME: join(dir, "cache") };
  for (const path of Object.values(env)) mkdirSync(path, { recursive: true });
  return env;
};

/** `tauri-driver`, and the app it opens, until `stop`. */
export async function openDesktop(options: DesktopOptions = {}): Promise<{ app: DesktopApp; stop: () => Promise<void> }> {
  // Before anything is spawned: a missing binary is not something to retry for 30 seconds.
  const application = desktopBinary();
  const port = await freePort();
  const nativePort = await freePort();
  const driver: ChildProcess = spawn(
    process.env.TAURI_DRIVER ?? "tauri-driver",
    ["--port", String(port), "--native-port", String(nativePort)],
    {
      stdio: ["ignore", "pipe", "pipe"],
      // A test must never open the person's own chats: its own profile, its own storage.
      env: {
        ...process.env,
        GHOSTLY_PROFILE: options.profile ?? process.env.GHOSTLY_PROFILE ?? "e2e",
        ...(options.home ? homeEnv(options.home) : {}),
        ...options.env,
      },
    },
  );
  const log: string[] = [];
  for (const stream of [driver.stdout, driver.stderr]) stream?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
  const died = new Promise<never>((_, fail) =>
    driver.on("exit", (code) => fail(new Error(`tauri-driver exited (${code}). Is it installed, with a WebDriver for this platform?\n${log.join("")}`))),
  );

  const endpoint = `http://127.0.0.1:${port}`;
  const kill = () => void driver.kill("SIGTERM");
  try {
    // The driver needs a moment to bind, and the app a while longer to boot.
    const app = await Promise.race([died, withRetries(() => Driver.open(endpoint, application), 30_000)]);
    // Closing the session closes the window; killing the driver ends what is left.
    return { app, stop: async () => { await app.close(); kill(); } };
  } catch (error) {
    kill();
    throw error;
  }
}

async function withRetries<T>(attempt: () => Promise<T>, budgetMs: number): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((done) => setTimeout(done, 300));
    }
  }
}

export const test = base.extend<{ app: DesktopApp }>({
  app: async ({}, use) => {
    const { app, stop } = await openDesktop();
    await use(app);
    await stop();
  },
});

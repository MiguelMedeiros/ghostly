/**
 * The real Chess (apps/mini/chess) in a store, for the end-to-end games (WISP 1200 § Publishing, § Stores): built from
 * its source, bundled and signed by the headless CLI (`ghostly app publish`, `store sign`, `app revoke`) with keys the
 * CLI makes in the test's own temporary folder (thrown away with it, never a real key), and served at
 * `raw.githubusercontent.com` URLs by `context.route` (serveStore): nothing leaves the machine.
 *
 * The CLI is the one Playwright's globalSetup built (support/headlessBuild.ts). Chess is built once per worker, into
 * a folder of that worker's own: a build empties its output folder, so two workers never share one.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BrowserContext, FrameLocator, Page } from "@playwright/test";
import { expect, type Peer, type PeerOptions } from "./fixtures";
import { serveStore } from "./appStore";

const ROOT = resolve(import.meta.dirname, "../..");
const CLI = join(ROOT, "packages/cli/dist/ghostly.mjs");

export const CHESS_REPO = "https://raw.githubusercontent.com/ghostly-e2e/chess/HEAD/";
export const CHESS_STORE_URL = "https://raw.githubusercontent.com/ghostly-e2e/store/HEAD/ghostly-store.json";
export const STORE_NAME = "E2E store";

let built: string | null = null;

/** Chess's one HTML file, built from apps/mini/chess for this worker. */
function chessEntry(): string {
  if (built) return built;
  const out = mkdtempSync(join(tmpdir(), "ghostly-e2e-chess-"));
  execFileSync("npx", ["vite", "build", "apps/mini/chess", "--outDir", out, "--emptyOutDir", "--logLevel", "error"], { cwd: ROOT, stdio: "ignore" });
  built = join(out, "index.html");
  return built;
}

/** The headless CLI's JSON answer. */
function ghostly(...args: string[]): Record<string, unknown> {
  return JSON.parse(execFileSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as Record<string, unknown>;
}

export interface Published { ref: string; digest: string; sequence: number; version: string; url: string; bytes: Uint8Array }

/**
 * A publisher of Chess and a curated store listing it, each with its own key, in a folder of their own. Every file
 * they publish goes in `files`, by URL, which `serve` answers from as each request comes (so a later publish shows).
 */
export class ChessPublisher {
  readonly files = new Map<string, Uint8Array>();
  private readonly dir: string;
  private storeSequence = 0;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "ghostly-e2e-publisher-"));
    mkdirSync(join(this.dir, "app"));
    copyFileSync(chessEntry(), join(this.dir, "app", "index.html"));
  }

  /** `ghostly app publish`: Chess as `version`, at `sequence`, served at `<repo>/<path>`; `view` as its manifest says (absent: in a chat). */
  publish({ version, sequence, path = "app.ghostlyapp", view }: { version: string; sequence: number; path?: string; view?: "chat" | "full" }): Published {
    writeFileSync(join(this.dir, "app", "ghostly-app.json"), JSON.stringify({
      name: "chess", version, kind: "mini-app", title: "Chess", tagline: "Play chess with a contact",
      description: "Chess for two, move by move, in your chat.", entry: "index.html", permissions: ["chat"],
      runtime: { host: ">=1.2", clients: ["web", "desktop"] }, license: "MIT", ...(view && { view }),
    }));
    const out = join(this.dir, "bundles", `${sequence}.ghostlyapp`);
    const made = ghostly("app", "publish", join(this.dir, "app"), "--key", join(this.dir, "publisher.key"), "--out", out, "--sequence", String(sequence));
    const url = CHESS_REPO + path;
    const bytes = new Uint8Array(readFileSync(out));
    this.files.set(url, bytes);
    return { ref: made.ref as string, digest: made.digest as string, sequence, version, url, bytes };
  }

  /** `ghostly app revoke`: the publisher's revocation of `app`'s digest, published beside it as ghostly-revoke.json. */
  revoke(app: Published, reason: string): void {
    const bundle = join(this.dir, "bundles", `${app.sequence}.ghostlyapp`);
    ghostly("app", "revoke", join(this.dir, "app"), "--key", join(this.dir, "publisher.key"), "--bundle", bundle, "--digest", app.digest, "--reason", reason);
    this.files.set(new URL("ghostly-revoke.json", app.url).href, new Uint8Array(readFileSync(join(this.dir, "app", "ghostly-revoke.json"))));
  }

  /** `ghostly store sign`: the store's next index, listing `apps` and removing `removed`. */
  signStore({ apps, removed = [] }: { apps: Published[]; removed?: { app: Published; reason: string }[] }): void {
    this.storeSequence += 1;
    const index = join(this.dir, "store", "index.json");
    mkdirSync(join(this.dir, "store"), { recursive: true });
    writeFileSync(index, JSON.stringify({
      ghostlyStore: 1, name: STORE_NAME, description: "Apps for the end-to-end tests.", kind: "curated", sequence: this.storeSequence,
      expires: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
      apps: apps.map((a) => ({ ref: a.ref, sequence: a.sequence, digest: a.digest, urls: [a.url], title: "Chess", tagline: "Play chess with a contact", category: "games" })),
      removed: removed.map(({ app, reason }) => ({ ref: app.ref, digest: app.digest, reason, at: Math.floor(Date.now() / 1000) })),
      revoked: [],
    }));
    const out = join(this.dir, "store", "signed");
    ghostly("store", "sign", index, "--key", join(this.dir, "store.key"), "--out", out);
    this.files.set(CHESS_STORE_URL, new Uint8Array(readFileSync(join(out, "ghostly-store.json"))));
    this.files.set(new URL("ghostly-store.sig", CHESS_STORE_URL).href, new Uint8Array(readFileSync(join(out, "ghostly-store.sig"))));
  }

  /** Answers GitHub's raw host (and jsDelivr) in `context` from `files`; returns what the context asked, in order. */
  serve(context: BrowserContext): Promise<string[]> {
    return serveStore(context, this);
  }
}

/** Adds the store by its link and installs Chess from its listing (the Apps page). */
export async function installFromStore(page: Page): Promise<void> {
  await page.goto("/#/apps");
  await expect(page.getByTestId("apps-page")).toBeVisible();
  await page.getByTestId("apps-add").click();
  await page.getByTestId("apps-add-url").fill(CHESS_STORE_URL);
  await page.getByTestId("apps-add-check").click();
  await expect(page.getByTestId("apps-add-store")).toContainText(STORE_NAME);
  await page.getByTestId("apps-add-store-confirm").click();
  const listed = page.getByTestId("app-store").filter({ hasText: STORE_NAME });
  await listed.getByRole("button", { name: new RegExp(STORE_NAME) }).click();
  await listed.getByTestId("app-listing-install").click();
  const screen = page.getByTestId("app-install");
  await expect(screen.getByTestId("app-store-line")).toHaveText(`In ${STORE_NAME}`);
  await screen.getByTestId("app-install-confirm").click();
  await expect(page.getByTestId("installed-app")).toContainText("Chess");
}

/** The app the runner opened, full screen over the page. */
export const miniApp = (page: Page) => page.getByTestId("mini-app");

/** Inside Chess's frame. */
export const chessFrame = (page: Page): FrameLocator => miniApp(page).frameLocator("iframe");

/** Which colour this side plays, once the toss is done ("w" or "b"). */
export async function colourOf(page: Page): Promise<"w" | "b"> {
  const side = chessFrame(page).locator(".side");
  await expect(side).toHaveText(/You play (white|black)/);
  return (await side.textContent())!.includes("white") ? "w" : "b";
}

/** One move by clicking its two squares, once it is this side's move; then the contact's board shows it. */
export async function move(mover: Page, watcher: Page, from: string, to: string): Promise<void> {
  const board = chessFrame(mover);
  await expect(board.locator(".status")).toHaveText(/^Your move/);
  await board.locator(`[data-square="${from}"]`).click();
  await expect(board.locator(`[data-square="${from}"]`)).toHaveClass(/\bselected\b/);
  await board.locator(`[data-square="${to}"]`).click();
  for (const page of [mover, watcher]) {
    await expect(chessFrame(page).locator(`[data-square="${to}"]`)).toHaveClass(/\blast\b/);
    await expect(chessFrame(page).locator(`[data-square="${from}"]`)).toHaveText("");
  }
}

/**
 * The peers of a test. In WebKit each gets a browser profile on disk, as a person's Safari has: WebKit's in-memory
 * contexts keep no Blob in IndexedDB and have no origin-private file system, so an app's bundle could not be stored
 * ("Error preparing Blob/File data to be stored in object store"). Playwright's WebKit keeps one origin-private file
 * system for all of them, so it is emptied before the first opens, and they open one after another.
 */
export async function openPeers(peer: (name: string, options?: PeerOptions) => Promise<Peer>, browserName: string, ...names: string[]): Promise<Peer[]> {
  if (browserName !== "webkit") return Promise.all(names.map((name) => peer(name)));
  const out: Peer[] = [];
  for (const [i, name] of names.entries()) out.push(await peer(name, { persistent: true, ...(i === 0 ? { beforeOpen: emptyFileStorage } : {}) }));
  return out;
}

async function emptyFileStorage(context: BrowserContext): Promise<void> {
  const page = await context.newPage();
  await page.goto("/version.json");
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const names: string[] = [];
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    for (const name of names) await root.removeEntry(name, { recursive: true });
  });
  await page.close();
}

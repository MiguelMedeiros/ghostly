/**
 * The real Chess in a store, for the end-to-end games (WISP 1200 § Publishing, § Stores): its pinned build
 * (support/chessFixture.ts, e2e/fixtures/chess: the page and the manifest of Chess 2.3.0, from the bundle its publisher
 * signed), bundled and signed again by the headless CLI (`ghostly app publish`,
 * `store sign`, `app revoke`) with keys the CLI makes in the test's own temporary folder (thrown away with it, never a
 * real key), and served at `raw.githubusercontent.com` URLs by `context.route` (serveStore): nothing leaves the machine.
 *
 * The CLI is the one Playwright's globalSetup built (support/headlessBuild.ts).
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BrowserContext, FrameLocator, Locator, Page } from "@playwright/test";
import { expect, type Peer, type PeerOptions } from "./fixtures";
import { serveStore } from "./appStore";
import { CHESS, type ChessBuild } from "./chessFixture";

const ROOT = resolve(import.meta.dirname, "../..");
const CLI = join(ROOT, "packages/cli/dist/ghostly.mjs");

export const CHESS_REPO = "https://raw.githubusercontent.com/ghostly-e2e/chess/HEAD/";
export const CHESS_STORE_URL = "https://raw.githubusercontent.com/ghostly-e2e/store/HEAD/ghostly-store.json";
export const STORE_NAME = "E2E store";

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
  }

  /**
   * `ghostly app publish`: `build` (absent: the Chess of today) under its own manifest, as `version` (absent: its own),
   * at `sequence`, served at `<repo>/<path>`, which its manifest names as its source; `view` instead of its own (in a chat).
   */
  publish({ build = CHESS, version = build.manifest.version, sequence, path = "app.ghostlyapp", view }: { build?: ChessBuild; version?: string; sequence: number; path?: string; view?: "chat" | "full" }): Published {
    const url = CHESS_REPO + path;
    copyFileSync(build.entry, join(this.dir, "app", "index.html"));
    writeFileSync(join(this.dir, "app", "ghostly-app.json"), JSON.stringify({ ...build.manifest, version, sources: [url], ...(view && { view }) }));
    const out = join(this.dir, "bundles", `${sequence}.ghostlyapp`);
    const made = ghostly("app", "publish", join(this.dir, "app"), "--key", join(this.dir, "publisher.key"), "--out", out, "--sequence", String(sequence));
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

/** Adds the store by its link and opens Chess's listing (the Apps page): the install screen, not yet confirmed. */
export async function openStoreInstall(page: Page): Promise<Locator> {
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
  return screen;
}

/** Adds the store by its link and installs Chess from its listing (the Apps page). */
export async function installFromStore(page: Page): Promise<void> {
  const screen = await openStoreInstall(page);
  await screen.getByTestId("app-install-confirm").click();
  await expect(page.getByTestId("installed-app")).toContainText("Chess");
}

/** The app the runner opened, full screen over the page. */
export const miniApp = (page: Page) => page.getByTestId("mini-app");

/** Inside Chess's frame. */
export const chessFrame = (page: Page): FrameLocator => miniApp(page).frameLocator("iframe");

/** Chess's status line. */
export const chessStatus = (page: Page): Locator => chessFrame(page).locator(".status");

/** A square of the board; its `data-piece` says what stands on it ("wp", "bn"...; "" when empty). */
export const square = (page: Page, name: string): Locator => chessFrame(page).locator(`[data-square="${name}"]`);

/** Which colour this side plays, once the toss is done ("w" or "b"). */
export async function colourOf(page: Page): Promise<"w" | "b"> {
  const side = chessFrame(page).locator(".side");
  await expect(side).toHaveText(/^You play (white|black)$/);
  return (await side.textContent())!.includes("white") ? "w" : "b";
}

/**
 * A game starts: `inviter` picks a time control on the setup card (absent: unlimited) and invites, `accepter` accepts
 * the invitation, and the toss gives each a colour. Both have Chess open. Returns [white, black].
 */
export async function startGame<T extends { page: Page }>(inviter: T, accepter: T, timeControl = "-"): Promise<[T, T]> {
  const setup = chessFrame(inviter.page).locator(".setup");
  await setup.locator(`.preset[data-tc="${timeControl}"]`).click();
  await setup.locator(".invite-btn").click();
  await chessFrame(accepter.page).locator(".invitation .accept-invite").click();
  for (const side of [inviter, accepter]) {
    await expect(chessFrame(side.page).locator(".setup")).toBeHidden();
    await expect(chessFrame(side.page).locator(".invitation")).toBeHidden();
    await expect(chessStatus(side.page)).toHaveText(/^(Your|Their) move$/);
  }
  const [first, second] = [await colourOf(inviter.page), await colourOf(accepter.page)];
  expect(first).not.toBe(second);
  return first === "w" ? [inviter, accepter] : [accepter, inviter];
}

/** One move by clicking its two squares, once it is this side's move; then the contact's board shows it. */
export async function move(mover: Page, watcher: Page, from: string, to: string): Promise<void> {
  await expect(chessStatus(mover)).toHaveText(/^Your move/);
  await square(mover, from).click();
  await expect(square(mover, from)).toHaveClass(/\bselected\b/);
  await square(mover, to).click();
  for (const page of [mover, watcher]) {
    await expect(square(page, to)).toHaveClass(/\blast\b/);
    await expect(square(page, from)).toHaveAttribute("data-piece", "");
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

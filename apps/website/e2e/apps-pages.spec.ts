import AxeBuilder from "@axe-core/playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

/**
 * The store pages, /apps and /apps/<name>.<publisher prefix> (app/apps/), and the release gate they sit behind
 * (lib/appsGate.ts). The build under test is served twice more, once as if the released Ghostly were 1.1 and once as if
 * it were 1.2 (GHOSTLY_SITE_RELEASE): on 1.1 nothing of Apps exists, not the pages, not a link, not a line of the
 * privacy policy; on 1.2 they show the test store (e2e/fixtures/store), which the build reads when
 * GHOSTLY_STORE_FIXTURE is set (CI sets it).
 */

const site = join(dirname(fileURLToPath(import.meta.url)), "..");
const snapshot = JSON.parse(readFileSync(join(site, "lib", "store-snapshot.json"), "utf8")) as { source: string };
const fixture = JSON.parse(readFileSync(join(site, "e2e", "fixtures", "store", "fixture.json"), "utf8")) as { key: string };
const PREFIX = { a: "jmbfdj6xdr6mp3op", b: "nsuz5d3mxqozm68b" };
const CHESS = `chess.${PREFIX.a}`;
const NOTES = `notes.${PREFIX.b}`;

const servers: ChildProcess[] = [];
const HIDDEN = "http://localhost:4410";
const LIVE = "http://localhost:4411";

/** `next start` for this build, with the release the gate reads. Its own process group, so the whole of it stops. */
async function serve(url: string, release: string) {
  const port = new URL(url).port;
  const child = spawn(process.execPath, [join(site, "node_modules", "next", "dist", "bin", "next"), "start", "-p", port], {
    cwd: site,
    env: { ...process.env, GHOSTLY_SITE_RELEASE: release },
    stdio: "ignore",
    detached: true,
  });
  servers.push(child);
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`next start on ${port} did not come up`);
}

test.describe.configure({ mode: "serial" });
test.skip(!!process.env.WEBSITE_URL, "Needs the local build: it serves it with a release of its choosing");

test.beforeAll(async () => {
  test.setTimeout(120_000);
  await Promise.all([serve(HIDDEN, "1.1.6"), serve(LIVE, "1.2.0")]);
});

test.afterAll(() => {
  for (const child of servers) {
    try {
      if (child.pid) process.kill(-child.pid);
    } catch {
      // already gone
    }
  }
});

/** Every request a page makes goes to the site itself. */
function sameOrigin(page: Page) {
  const hosts = new Set<string>();
  page.on("request", (req) => {
    if (!req.url().startsWith("data:")) hosts.add(new URL(req.url()).host);
  });
  return () => [...hosts].filter((h) => h !== new URL(page.url()).host);
}

async function axe(page: Page): Promise<string[]> {
  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations === 1).map((a) => a.finished.catch(() => {})));
  });
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(" ")}`));
}

test.describe("before the release that has Apps", () => {
  test("the pages and the icons are not found", async ({ request }) => {
    for (const path of ["/apps", `/apps/${CHESS}`, `/apps/${CHESS}/app-icon`, "/apps/nothing.here"]) {
      expect((await request.get(HIDDEN + path)).status(), path).toBe(404);
    }
  });

  test("nothing links to them, and the privacy policy says nothing of stores", async ({ page, request }) => {
    await page.goto(`${HIDDEN}/privacy`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Privacy Policy");
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Apps", exact: true })).toHaveCount(0);
    await expect(page.locator("footer").getByRole("link", { name: "Apps", exact: true })).toHaveCount(0);
    await expect(page.locator('a[href^="/apps"]')).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText("cdn.jsdelivr.net");
    await expect(page.locator("main")).not.toContainText("Apps and stores");
    const xml = await (await request.get(`${HIDDEN}/sitemap.xml`)).text();
    expect(xml).toContain("<loc>https://ghostly.tools/privacy</loc>");
    expect(xml).not.toContain("/apps");
  });
});

test.describe("once the released Ghostly has Apps", () => {
  test.skip(snapshot.source !== "fixture", "Build with GHOSTLY_STORE_FIXTURE=1 to check the pages on the test store");

  test("/apps lists the apps that verified, and nothing else", async ({ page }) => {
    const others = sameOrigin(page);
    await page.goto(`${LIVE}/apps`);
    await expect(page).toHaveTitle("Apps | Ghostly");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://ghostly.tools/apps");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Apps for your chats");
    const cards = page.locator(".ap-card");
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toContainText("Test Chess");
    await expect(cards.nth(0)).toContainText("Play chess with a contact, live in your chat");
    await expect(cards.nth(0)).toHaveAttribute("href", `/apps/${CHESS}`);
    await expect(cards.nth(1)).toContainText("Test Notes");
    // Removed, revoked, another version than listed, and a host the app never reads from.
    for (const title of ["Removed App", "Revoked App", "Older App", "Elsewhere App"]) await expect(page.locator("main")).not.toContainText(title);
    await expect(page.locator(".ap-count")).toHaveText("2 apps");
    await expect(page.locator(".ap-store")).toContainText(`Test Store. Signed by the store key ${fixture.key.slice(0, 16).match(/.{4}/g)!.join(" ")}.`);
    await expect(page.locator(".ap-card img")).toHaveCount(1);
    expect(await page.locator(".ap-card img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(64);
    expect(others()).toEqual([]);
  });

  test("an app's page: what it is, what it may do, who signed it, how to install it", async ({ page }) => {
    const others = sameOrigin(page);
    await page.goto(`${LIVE}/apps`);
    await page.locator(".ap-card", { hasText: "Test Chess" }).click();
    await expect(page).toHaveURL(`${LIVE}/apps/${CHESS}`);
    await expect(page).toHaveTitle("Test Chess: Ghostly app | Ghostly");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Test Chess");
    const main = page.locator("main");
    await expect(main).toContainText("Two players, one board, moves sent over the chat.");
    await expect(main.locator(".ap-meta")).toContainText("Version1.0.2");
    await expect(main.locator(".ap-perms li")).toHaveText([
      "Keep its own data on this device, separately in each chat",
      "Talk to the same app on your contact's side, while you are both in the chat",
    ]);
    await expect(main).toContainText("No internet access. Its publisher may still learn your IP address and when you open it.");
    await expect(main).toContainText("Inside a one-to-one chat, with a contact who has it too.");
    const fingerprint = `${PREFIX.a.slice(0, 4)} ${PREFIX.a.slice(4, 8)} ${PREFIX.a.slice(8, 12)} ${PREFIX.a.slice(12, 16)}`;
    await expect(main.locator(".ap-steps li")).toHaveCount(4);
    await expect(main.locator(".ap-steps li").nth(2)).toHaveText(`Find Test Chess, check that its publisher key starts with ${fingerprint}, and press Install.`);
    await expect(main.locator(".ap-fingerprint")).toHaveText(fingerprint);
    await expect(main.locator(".ap-code")).toHaveText("https://raw.githubusercontent.com/ghostly-fixtures/chess/HEAD/app.ghostlyapp");
    await expect(main.getByRole("link", { name: "Open Ghostly" })).toHaveAttribute("href", "https://app.ghostly.tools");
    expect(await main.locator("img.ap-icon").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(64);
    await expect(main).toContainText("Clocks for both players.");
    await expect(main).toContainText("Listed by Test Store, reviewed by its maintainers.");
    expect(others()).toEqual([]);
  });

  test("an app with the internet permission says so, and one without an icon shows its letter", async ({ page, request }) => {
    await page.goto(`${LIVE}/apps/${NOTES}`);
    const main = page.locator("main");
    await expect(main.locator(".ap-perms li")).toHaveCount(4);
    await expect(main.locator(".ap-perms li").last()).toContainText("Use the internet");
    await expect(main.locator(".ap-perms li").last()).toContainText("can learn your IP address");
    await expect(main).not.toContainText("No internet access");
    await expect(main).toContainText("Full screen, on its own or from a chat.");
    await expect(main.locator(".ap-icon--letter")).toHaveText("T");
    expect((await request.get(`${LIVE}/apps/${NOTES}/app-icon`)).status()).toBe(404);
    const icon = await request.get(`${LIVE}/apps/${CHESS}/app-icon`);
    expect(icon.headers()["content-type"]).toBe("image/png");
    for (const path of ["/apps/nothing.here", `/apps/gone.${PREFIX.a}`, `/apps/older.${PREFIX.a}`]) expect((await request.get(LIVE + path)).status(), path).toBe(404);
  });

  test("the nav, the footer, the sitemap and the privacy policy name them", async ({ page, request }) => {
    await page.goto(`${LIVE}/apps`);
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link", { name: "Apps", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.locator("footer").getByRole("link", { name: "Apps", exact: true })).toHaveAttribute("href", "/apps");
    for (const width of [1280, 960]) {
      await page.setViewportSize({ width, height: 800 });
      const tops = await page.locator(".nav-links a, .nav-open-main").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
      expect(new Set(tops).size, `a link wrapped at ${width}px`).toBe(1);
    }
    const xml = await (await request.get(`${LIVE}/sitemap.xml`)).text();
    for (const path of ["/apps", `/apps/${CHESS}`, `/apps/${NOTES}`]) expect(xml).toContain(`<loc>https://ghostly.tools${path}</loc>`);
    await page.goto(`${LIVE}/privacy`);
    const main = page.locator("main");
    await expect(main).toContainText("Apps and stores.");
    await expect(main).toContainText("The apps pages.");
    await expect(main).toContainText("cdn.jsdelivr.net");
    await expect(main).toContainText("Last updated: October 8, 2026");
  });

  test("on a phone, nothing is wider than the screen", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of ["/apps", `/apps/${CHESS}`]) {
      await page.goto(LIVE + path);
      expect(await page.evaluate(() => document.documentElement.scrollWidth), path).toBeLessThanOrEqual(390);
    }
  });

  test("axe finds nothing serious on either page", async ({ page }) => {
    for (const path of ["/apps", `/apps/${CHESS}`, `/apps/${NOTES}`]) {
      await page.goto(LIVE + path);
      expect(await axe(page), path).toEqual([]);
    }
  });
});

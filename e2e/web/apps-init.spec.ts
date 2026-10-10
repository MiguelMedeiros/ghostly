import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FrameLocator, Page } from "@playwright/test";
import { chat, expect, test } from "../support/fixtures";
import { pair } from "../support/paired";
import { composerRow } from "../support/composer";
import { serveStore } from "../support/appStore";
import { miniApp, openPeers } from "../support/chessApp";

/*
 * The app `ghostly app init` writes (WISP 1200 § Publishing), on the e2e suite's build (VITE_APPS_TEST): the headless
 * CLI makes the folder and signs it as it is, with a key made for the test, and the test serves the bundle at a
 * raw.githubusercontent.com URL. Ana adds it by that URL and opens it in her chat with Bob, Bob installs it from her
 * card, and each side's hello shows on the other's page, over `paired-app`.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const CLI = join(ROOT, "packages/cli/dist/ghostly.mjs");
const APP_URL = "https://raw.githubusercontent.com/ghostly-e2e/hello/HEAD/app.ghostlyapp";

/** The headless CLI's JSON answer. */
function ghostly(...args: string[]): Record<string, unknown> {
  return JSON.parse(execFileSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as Record<string, unknown>;
}

/** `ghostly app init` then `ghostly app publish`, with `sources` set to where the test serves the bundle. */
function publishTemplate(): Map<string, Uint8Array> {
  const root = mkdtempSync(join(tmpdir(), "ghostly-e2e-init-"));
  const dir = join(root, "hello");
  ghostly("app", "init", dir, "--title", "Hello");
  const source = join(dir, "ghostly-app.json");
  writeFileSync(source, JSON.stringify({ ...JSON.parse(readFileSync(source, "utf8")) as object, sources: [APP_URL] }));
  ghostly("app", "publish", dir, "--key", join(root, "publisher.key"));
  expect(ghostly("app", "verify", join(dir, "app.ghostlyapp"))).toMatchObject({ valid: true, name: "hello", title: "Hello" });
  return new Map([[APP_URL, new Uint8Array(readFileSync(join(dir, "app.ghostlyapp")))]]);
}

const appFrame = (page: Page): FrameLocator => miniApp(page).frameLocator("iframe");

test("the app that app init writes is published, opens in a chat, and says hello both ways", { tag: ["@feature:apps.chat.wire"] }, async ({ peer, browserName }) => {
  const files = publishTemplate();
  const [ana, bob] = await openPeers(peer, browserName, "ana", "bob");
  await Promise.all([serveStore(ana.context, { files }), serveStore(bob.context, { files })]);

  // Ana adds the app by its URL, then opens it in her chat with Bob.
  await ana.page.goto("/#/apps");
  await ana.page.getByTestId("apps-add").click();
  await ana.page.getByTestId("apps-add-url").fill(APP_URL);
  await ana.page.getByTestId("apps-add-check").click();
  await ana.page.getByTestId("app-install").getByTestId("app-install-confirm").click();
  await expect(ana.page.getByTestId("installed-app")).toContainText("Hello");
  await ana.page.goto("/#/");
  await pair(ana, bob);
  await (await composerRow(ana.page, "composer-apps")).click();
  await ana.page.getByTestId("chat-apps").getByTestId("chat-app-open").click();
  await expect(miniApp(ana.page)).toBeVisible();
  await expect(appFrame(ana.page).locator("h1")).toHaveText("Hello");
  await expect(appFrame(ana.page).locator("#status")).toHaveText("Waiting for your contact to open this app");

  // Before Bob has it open, a hello is refused, and the page says why.
  await appFrame(ana.page).locator("#hello").click();
  await expect(appFrame(ana.page).locator("#log li")).toHaveText(["Not sent: your contact has not opened this app"]);

  // Bob installs it from Ana's card.
  await chat(bob).getByTestId("app-card").getByTestId("app-card-install").click();
  await bob.page.getByTestId("app-install").getByTestId("app-install-confirm").click();
  await expect(miniApp(bob.page)).toBeVisible();
  for (const page of [ana.page, bob.page]) await expect(appFrame(page).locator("#status")).toHaveText("Your contact has this app open");

  // A hello each way.
  await appFrame(ana.page).locator("#hello").click();
  await expect(appFrame(bob.page).locator("#log li")).toHaveText(["Your contact: Hello!"]);
  await appFrame(bob.page).locator("#hello").click();
  await expect(appFrame(ana.page).locator("#log li")).toHaveText(["Not sent: your contact has not opened this app", "You: Hello!", "Your contact: Hello!"]);
  await expect(appFrame(bob.page).locator("#log li")).toHaveText(["Your contact: Hello!", "You: Hello!"]);
});

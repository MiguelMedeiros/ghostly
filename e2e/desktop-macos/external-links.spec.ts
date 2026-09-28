import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { desktopPerson, type DesktopPerson } from "../matrix/people";
import { HYPERDHT_TESTNET } from "../matrix/desktop";
import { forgetSharedData, openMacDesktop, type MacDesktop } from "../support/desktopMac";
import { HeadlessBot } from "../support/headless";
import { LocalRelay } from "../support/relay";

/**
 * A link to another site opens in the system browser from the Desktop app on a Mac, in the real WKWebView. The app's
 * WebView drops a `target="_blank"` click, so every such link calls Rust (`open_web_link`, src/lib/externalLink.ts),
 * which hands it to `open` (#415 for links in messages, #421 for the rest). Unit tests prove that with Tauri mocked;
 * this proves it where a WebKit-only change would break it.
 *
 * The app under the test driver writes down what it would open instead of starting a browser (`launch` in
 * src-tauri/src/commands.rs), and `opened()` reads that list. The address has "ã" in it: the page sends it
 * percent-encoded, since Rust takes plain ASCII only.
 *
 * The second link is Settings → About → GitHub. The update Download link is the same kind of link, but a Mac never
 * shows it: it appears only for an update this install cannot apply, which on Desktop is a Linux `.deb` or `.rpm`.
 *
 *   npm run desktop:macos:build
 *   npm run test:e2e:desktop-macos -- external-links
 */

// 49740-49749: this test's ports.
const PORTS = { relay: 49741, dht: 49742, a: 49745 };
const LINK = "https://pt.wikipedia.org/wiki/São_Paulo";
const ENCODED = "https://pt.wikipedia.org/wiki/S%C3%A3o_Paulo";
const WEBSITE = "https://github.com/MiguelMedeiros/ghostly";

test("a link in a message and one in Settings open in the system browser", {
  tag: ["@client:desktop", "@feature:app.external-links", "@feature:chat.paired.links"],
}, async ({}, testInfo) => {
  test.skip(process.platform !== "darwin", "macOS only: the system WKWebView");
  const relay = new LocalRelay();
  const { default: testnet } = (await import(HYPERDHT_TESTNET)) as { default: (size: number, opts?: { port?: number }) => Promise<{ bootstrap: { host: string; port: number }[]; destroy(): Promise<void> }> };
  const dht = await testnet(3, { port: PORTS.dht });
  const relayUrl = await relay.listen(PORTS.relay);
  const bootstrap = dht.bootstrap.map((node) => `${node.host}:${node.port}`).join(",");
  const env = { GHOSTLY_PKARR_RELAYS: relayUrl, GHOSTLY_HYPERDHT_BOOTSTRAP: bootstrap };
  // The bot's processes inherit this: the same HyperDHT network as the app.
  process.env.GHOSTLY_HYPERDHT_BOOTSTRAP = bootstrap;
  const bot = new HeadlessBot();
  const apps: MacDesktop[] = [];
  let alice: DesktopPerson | undefined;
  const keep = async (name: string, body: string) => {
    writeFileSync(testInfo.outputPath(name), body);
    await testInfo.attach(name, { path: testInfo.outputPath(name), contentType: "text/plain" });
  };
  forgetSharedData();
  try {
    await bot.start(relayUrl, "Link bot");
    alice = await desktopPerson("links", {
      env,
      open: async () => {
        const desktop = await openMacDesktop({ name: "links", port: PORTS.a, env });
        apps.push(desktop);
        return { app: desktop.app, stop: () => desktop.stop() };
      },
    });
    // The driver of the app that is running: `opened()` is the Mac driver's.
    const app = apps[apps.length - 1].app;

    await test.step("pair: the bot's invite, joined by the app", async () => {
      const invite = await bot.run("invite", "create", "--label", "mac");
      await alice!.join(invite.link as string);
      await expect.poll(() => alice!.canWrite(), { timeout: 120_000 }).toBe(true);
      await bot.run("chat", "wait", invite.chat as string, "--until", "live", "--timeout", "120");
      await bot.run("send", invite.chat as string, `São Paulo: ${LINK}`, "--wait", "delivered");
    });

    await test.step("the link in the message opens, percent-encoded", async () => {
      const anchor = '.chat-wallpaper a[href*="pt.wikipedia.org"]';
      await expect.poll(() => app.attribute(anchor, "href"), { timeout: 60_000 }).toBe(LINK);
      expect(await app.opened()).toEqual([]);
      await app.click(anchor);
      await expect.poll(() => app.opened()).toEqual([ENCODED]);
      // The click opened nothing inside the app: the chat is still on screen.
      expect(await alice!.canWrite()).toBe(true);
    });

    await test.step("Settings → About → GitHub opens too", async () => {
      await alice!.go("#/settings");
      await app.click(`a[href="${WEBSITE}"]`);
      await expect.poll(() => app.opened()).toEqual([ENCODED, WEBSITE]);
    });
  } catch (error) {
    if (alice) await keep("app-page.txt", await alice.snapshot().catch((e: unknown) => String(e)));
    await keep("bot-events.txt", bot.events.map((e) => JSON.stringify(e)).join("\n"));
    for (const d of apps) await keep(`${d.bundleId}-log.txt`, d.log.join(""));
    throw error;
  } finally {
    await Promise.all(apps.map((d) => d.stop()));
    await bot.stop();
    forgetSharedData();
    relay.close();
    await dht.destroy();
  }
});

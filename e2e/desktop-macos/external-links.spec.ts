import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { desktopPerson, type DesktopPerson } from "../matrix/people";
import { HYPERDHT_TESTNET } from "../matrix/desktop";
import { forgetSharedData, openMacDesktop, type MacDesktop } from "../support/desktopMac";
import { HeadlessBot } from "../support/headless";
import { LocalRelay } from "../support/relay";

/**
 * A link to another site opens in the system browser from the Desktop app on a Mac, in the real WKWebView. The app's
 * WebView drops a `target="_blank"` click, so every such link calls Rust (`open_web_link`, apps/ui/src/lib/externalLink.ts),
 * which hands it to `open` (#415 for links in messages, #421 for the rest). Unit tests prove that with Tauri mocked;
 * this proves it where a WebKit-only change would break it.
 *
 * The app under the test driver writes down what it would open instead of starting a browser (`launch` in
 * apps/desktop/src/commands.rs), and `opened()` reads that list. The address has "ã" in it: the page sends it
 * percent-encoded, since Rust takes plain ASCII only.
 *
 * The second link is Settings → About → GitHub. The update Download link is the same kind of link, but a Mac never
 * shows it: it appears only for an update this install cannot apply, which on Desktop is a Linux `.deb` or `.rpm`.
 *
 * With the app paired, the same test checks the Dock icon's badge: a message that comes while Settings is open puts
 * "1" on it, the count the web app's icon would show, and opening the chat clears it; so does one that comes while the
 * window is closed with the chat open, until the window shows again. The driver reads the label
 * AppKit holds for the icon (the copy under test stays out of the Dock, so nobody sees it there).
 *
 *   npm run desktop:macos:build
 *   npm run test:e2e:desktop-macos -- external-links
 */

// 49750-49759: this test's ports.
const PORTS = { relay: 49751, dht: 49752, a: 49755 };
const LINK = "https://pt.wikipedia.org/wiki/São_Paulo";
const ENCODED = "https://pt.wikipedia.org/wiki/S%C3%A3o_Paulo";
const WEBSITE = "https://github.com/MiguelMedeiros/ghostly";

test("a link in a message and one in Settings open in the system browser", {
  tag: ["@client:desktop", "@feature:app.external-links", "@feature:chat.paired.links", "@feature:app.attention.badge"],
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
  let botChat = "";
  let chatHash = "";
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
      botChat = invite.chat as string;
      chatHash = await alice!.hash();
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

    await test.step("a message that comes while Settings is open puts 1 on the Dock icon; opening the chat clears it", async () => {
      expect((await app.windowState()).badge).toBeNull();
      await bot.run("send", botChat, "Unread on the Dock", "--wait", "delivered");
      await expect.poll(async () => (await app.windowState()).badge, { timeout: 30_000 }).toBe("1");
      await alice!.go(chatHash);
      await expect.poll(async () => (await app.windowState()).badge, { timeout: 30_000 }).toBeNull();
    });

    await test.step("a message that comes while the window is closed with the chat open puts 1 on the Dock icon; showing it clears it", async () => {
      // The chat open in a hidden window has not been read (hooks/usePageShown.ts): it was read at once, so no badge.
      await app.close();
      await expect.poll(async () => (await app.windowState()).visible).toBe(false);
      await bot.run("send", botChat, "Unread behind the Dock", "--wait", "delivered");
      await expect.poll(async () => (await app.windowState()).badge, { timeout: 30_000 }).toBe("1");
      // And it stays: the open chat used to mark it read a moment after it came, which took the "1" off again.
      await new Promise((done) => setTimeout(done, 6_000));
      expect((await app.windowState()).badge).toBe("1");
      await app.reopen();
      await expect.poll(async () => (await app.windowState()).badge, { timeout: 30_000 }).toBeNull();
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

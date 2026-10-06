import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { HeadlessBot } from "../support/headless";
import { LocalRelay } from "../support/relay";
import { forgetSharedData, openMacDesktop, type MacDesktop } from "../support/desktopMac";
import { desktopPerson, type DesktopPerson } from "../matrix/people";

const HYPERDHT_TESTNET = "hyperdht/testnet.js";

/**
 * HyperDHT on the Mac: the Desktop runs it in its packaged runtime (Node and sidecar.mjs, apps/desktop/src/hyperdht.rs),
 * found in the app's resource folder. Chosen in a chat's Connection menu, the chat with a headless bot goes live over
 * it on a HyperDHT testnet, and texts go both ways.
 *
 * Until 2026-10-06 every copy this suite started ran without that runtime: the copies sat under macOS's temporary
 * folder, reached through the /var link, and Tauri gave such an app no resource folder ("unknown path"), so the menu
 * showed HyperDHT off with "Native adapter could not start" (support/desktopMac.ts `copyApp`).
 *
 *   npm run desktop:macos:build
 *   npm run test:e2e:desktop-macos -- hyperdht
 */

// 48580-48589: this test's ports.
const PORTS = { relay: 48581, dht: 48582, a: 48585 };

test("a chat with a bot goes live over HyperDHT chosen in the Mac app's Connection menu", {
  tag: ["@client:desktop", "@feature:transport.hyperdht"],
}, async ({}, testInfo) => {
  test.skip(process.platform !== "darwin", "macOS only: the system WKWebView");
  const relay = new LocalRelay();
  const { default: testnet } = (await import(HYPERDHT_TESTNET)) as { default: (size: number, opts?: { port?: number }) => Promise<{ bootstrap: { host: string; port: number }[]; destroy(): Promise<void> }> };
  const dht = await testnet(3, { port: PORTS.dht });
  const relayUrl = await relay.listen(PORTS.relay);
  const bootstrap = dht.bootstrap.map((node) => `${node.host}:${node.port}`).join(",");
  const env = { GHOSTLY_PKARR_RELAYS: relayUrl, GHOSTLY_HYPERDHT_BOOTSTRAP: bootstrap };
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
    await bot.start(relayUrl, "HyperDHT bot");
    alice = await desktopPerson("hyperdht", {
      env,
      open: async () => {
        const desktop = await openMacDesktop({ name: "hyperdht", port: PORTS.a, env });
        apps.push(desktop);
        return { app: desktop.app, stop: () => desktop.stop() };
      },
    });
    let chat = "";

    await test.step("pair with the bot", async () => {
      const invite = await bot.run("invite", "create", "--label", "mac");
      chat = invite.chat as string;
      await alice!.join(invite.link as string);
      await expect.poll(() => alice!.canWrite(), { timeout: 120_000 }).toBe(true);
      await bot.run("chat", "wait", chat, "--until", "live", "--timeout", "120");
    });

    await test.step("HyperDHT chosen in the menu: the chat goes live over it", async () => {
      // The listener starts with the chat: the option is on once both apps run it.
      await expect.poll(async () => (await alice!.preferTransport(undefined, true)).includes("HyperDHT"), { timeout: 30_000, message: "the menu offers HyperDHT" }).toBe(true);
      await alice!.preferTransport("HyperDHT", false);
      await expect.poll(() => alice!.connection(), { timeout: 60_000 }).toMatch(/Connected · HyperDHT/);
      await expect.poll(async () => (await bot.run("chat", "show", chat)).transport, { timeout: 30_000 }).toBe("hyperdht/1");
    });

    await test.step("texts go both ways over it", async () => {
      await alice!.say("from the Mac over HyperDHT");
      await bot.event((e) => e.type === "message.received" && JSON.stringify(e).includes("from the Mac over HyperDHT"));
      await bot.run("send", chat, "from the bot over HyperDHT", "--wait", "delivered");
      await expect.poll(() => alice!.shows("from the bot over HyperDHT"), { timeout: 30_000 }).toBe(true);
      expect(await alice!.connection()).toMatch(/Connected · HyperDHT/);
    });
  } catch (error) {
    if (alice) await keep("app-page.txt", await alice.snapshot().catch((e: unknown) => String(e)));
    await bot.attachLogs(testInfo);
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

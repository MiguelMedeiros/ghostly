import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { desktopPerson, type DesktopPerson } from "../matrix/people";
import { HYPERDHT_TESTNET } from "../matrix/desktop";
import { strangerInvoice } from "../support/bolt11";
import { forgetSharedData, openMacDesktop, type MacDesktop } from "../support/desktopMac";
import { HeadlessBot } from "../support/headless";
import { LocalRelay } from "../support/relay";

/**
 * "Open in wallet" on a Lightning invoice or a Bitcoin payment link in a message opens the Mac's wallet app. In the
 * app's WKWebView a `lightning:` or `bitcoin:` link goes nowhere: WebKit hands no custom scheme to the system. The
 * link calls Rust (`open_payment_link`), which hands it to `open`, as Pay externally's does.
 *
 * The app under the test driver writes down what it would open instead (`launch` in apps/desktop/src/commands.rs).
 *
 *   npm run desktop:macos:build
 *   npm run test:e2e:desktop-macos -- payment-links
 */

// 48570-48579: this test's ports.
const PORTS = { relay: 48571, dht: 48572, a: 48575 };
const BIP21 = "bitcoin:tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx?amount=0.0001&label=Coffee";

test("Open in wallet on an invoice and a payment link in a message opens the system's wallet", {
  tag: ["@client:desktop", "@feature:payments.lightning.invoice-card", "@feature:payments.money.onchain-card", "@feature:payments.uri"],
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
  const invoice = strangerInvoice(2_100, "coffee");
  forgetSharedData();
  try {
    await bot.start(relayUrl, "Wallet bot");
    alice = await desktopPerson("paylinks", {
      env,
      open: async () => {
        const desktop = await openMacDesktop({ name: "paylinks", port: PORTS.a, env });
        apps.push(desktop);
        return { app: desktop.app, stop: () => desktop.stop() };
      },
    });
    const app = apps[apps.length - 1].app;

    await test.step("pair, and the bot sends an invoice and a payment link", async () => {
      const invite = await bot.run("invite", "create", "--label", "mac");
      await alice!.join(invite.link as string);
      await expect.poll(() => alice!.canWrite(), { timeout: 120_000 }).toBe(true);
      await bot.run("chat", "wait", invite.chat as string, "--until", "live", "--timeout", "120");
      await bot.run("send", invite.chat as string, invoice, "--wait", "delivered");
      await bot.run("send", invite.chat as string, BIP21, "--wait", "delivered");
    });

    await test.step("the invoice's Open in wallet hands lightning: to the system", async () => {
      const anchor = '.chat-wallpaper [data-testid="invoice-bubble"] a[href^="lightning:"]';
      await expect.poll(() => app.attribute(anchor, "href"), { timeout: 60_000 }).toBe(`lightning:${invoice}`);
      expect(await app.opened()).toEqual([]);
      await app.click(anchor);
      await expect.poll(() => app.opened()).toEqual([`lightning:${invoice}`]);
      expect(await alice!.canWrite()).toBe(true);
    });

    await test.step("the payment link's Open in wallet hands bitcoin: to the system", async () => {
      const anchor = '.chat-wallpaper [data-testid="onchain-bubble"] a[href^="bitcoin:"]';
      await expect.poll(() => app.attribute(anchor, "href"), { timeout: 60_000 }).toBe(BIP21);
      await app.click(anchor);
      await expect.poll(() => app.opened()).toEqual([`lightning:${invoice}`, BIP21]);
      expect(await alice!.canWrite()).toBe(true);
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

import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { attachDesktopLogs, desktopHome } from "../support/desktop";
import { LocalRelay } from "../support/relay";
import { desktopNetwork } from "../matrix/desktop";
import { desktopPerson, type DesktopPerson } from "../matrix/people";

/**
 * The current Desktop and a real older Desktop: what a contact who has not updated their Desktop yet still does with
 * it. v1.1.5, and the newest release with a published package, read from the tags: the common case, a contact who
 * updates a day later. The web compatibility suite (e2e/compat/) covers old web builds; this is the other side, the
 * Rust host and its native transports, which a web build never runs.
 *
 * The old app is the release's own Linux package (tools/scripts/fetch-compat-desktop.mjs), what people installed.
 * E2E_COMPAT_LATEST names the newest release instead of asking the remote, as in the web suite.
 * A chat pairs from either side's invite, texts go both ways over the DHT, then both go live on Iroh or HyperDHT
 * (WebKitGTK has no WebRTC, so no other transport is possible) and texts go both ways live, each shown once.
 *
 * Nothing leaves the machine: both apps read and publish on the test's Pkarr relay and meet on a HyperDHT testnet in
 * this process, as in native-upgrade.spec.ts.
 */

/**
 * A release's binary and its version: fetched once, then from the cache. `newest` is the newest release whose package
 * is published, a draft's tag passed over. Skips the test where no tool unpacks the release's package.
 */
const oldBinary = (tag: string) => {
  const fetched = spawnSync(process.execPath, ["tools/scripts/fetch-compat-desktop.mjs", "--tag", tag], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  process.stderr.write(fetched.stderr ?? "");
  test.skip(fetched.status === 3, `The ${tag} package cannot be unpacked here: ${(fetched.stderr ?? "").trim().split("\n").at(-1)}`);
  if (fetched.error || fetched.status !== 0) throw fetched.error ?? new Error(`fetch-compat-desktop.mjs ended with status ${fetched.status}`);
  const binary = fetched.stdout.trim();
  // <cache>/desktop-<tag>/usr/bin/ghostly
  return { binary, version: basename(resolve(binary, "../../..")).replace(/^desktop-v/, "") };
};

/** How many times the open conversation shows this exact text: once, or it was lost or doubled. */
const count = (p: DesktopPerson, text: string) => p.app.execute<number>(`
  const pane = document.querySelector(".chat-wallpaper");
  return pane ? [...pane.querySelectorAll("*")].filter((e) => e.childElementCount === 0 && e.textContent === arguments[0]).length : 0;`, text);

const version = (p: DesktopPerson) => p.app.executeAsync<string>(`
  const done = arguments[arguments.length - 1];
  window.__TAURI_INTERNALS__.invoke("plugin:app|version").then(done, (e) => done("error: " + e));`);

const shownOnce = (p: DesktopPerson, text: string, timeout: number) =>
  expect.poll(() => count(p, text), { timeout, message: `${p.name} shows “${text}” once` }).toBe(1);

test.skip(process.platform !== "linux" || process.arch !== "x64", "The release's Desktop package is Linux x64 only");

const RELEASES = [
  { name: "v1.1.5", release: "v1.1.5", tag: ["@feature:chat.compat.v115.desktop"] },
  { name: "the newest release", release: process.env.E2E_COMPAT_LATEST || "newest", tag: ["@feature:chat.compat.latest.desktop"] },
];

for (const { name, release, tag } of RELEASES) for (const host of ["current", "old"] as const) {
  test(`a chat from the ${host} Desktop's invite goes both ways between the current Desktop and ${name}, over the DHT and then live`, {
    tag: [...tag, "@feature:chat.native-upgrade"],
  }, async () => {
    test.setTimeout(10 * 60_000);
    const { binary, version: old } = oldBinary(release);
    const relay = new LocalRelay();
    const network = await desktopNetwork(relay);
    const cleanup: (() => Promise<void> | void)[] = [() => relay.close(), () => network.close()];
    try {
      const open = async (name: string, old: boolean): Promise<DesktopPerson> => {
        const home = desktopHome(name);
        const person = await desktopPerson(name, { home: home.dir, env: network.env, ...(old ? { binary } : {}) });
        cleanup.push(async () => { await person.stop(); attachDesktopLogs(name, home.dir); home.remove(); });
        return person;
      };
      const [nina, olga] = await Promise.all([open("nina", false), open("olga", true)]);
      // The old app is the one we think it is. Not the current one by its number: dev keeps the last release's version
      // until the next bump, so the current Desktop can say the newest release's.
      expect(await version(olga)).toBe(old);

      const [inviter, joiner] = host === "current" ? [nina, olga] : [olga, nina];
      await inviter.press("New chat");
      const invite = await inviter.copyInvite();
      expect(invite).toMatch(/^https:\/\/ghostly\.tools\/#ghostly1p/);
      await joiner.join(invite);
      for (const p of [nina, olga]) {
        await expect.poll(() => p.canWrite(), { timeout: 120_000, message: `${p.name}'s chat is open` }).toBe(true);
        p.chatHash = await p.hash();
      }

      // Before any live link, over the DHT: one text at a time each way, as a person waits for the receipt.
      for (const [from, to] of [[nina, olga], [olga, nina]]) {
        const text = `from ${from.name}, over the DHT`;
        await from.say(text);
        await shownOnce(to, text, 180_000);
        await expect.poll(() => from.awaitingReceipt(), { timeout: 180_000, message: `${from.name}'s text is received` }).toBe(false);
      }

      // Then both go live on a native transport, dialled from the other's capability record.
      for (const p of [nina, olga]) {
        await expect.poll(() => p.connection(), { timeout: 180_000, message: `${p.name} goes live on a native transport` })
          .toMatch(/Connected · (Iroh|HyperDHT)/);
      }

      // Live: texts both ways, back to back, each arriving once on both sides.
      const texts: [DesktopPerson, string][] = [];
      for (let i = 1; i <= 3; i++) texts.push([nina, `live from nina ${i}`], [olga, `live from olga ${i}`]);
      for (const [from, text] of texts) await from.say(text);
      for (const [, text] of texts) for (const p of [nina, olga]) await shownOnce(p, text, 60_000);
      for (const p of [nina, olga]) expect(await p.awaitingReceipt(), `${p.name} has nothing awaiting a receipt`).toBe(false);
    } finally {
      for (const done of cleanup.reverse()) await done();
    }
  });
}

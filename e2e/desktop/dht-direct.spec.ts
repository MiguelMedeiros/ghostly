import { test, expect } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { desktopHome } from "../support/desktop";
import { longestEventLoopGap, watchEventLoop } from "../support/eventLoop";
import { mainlineTestnet } from "../support/mainlineTestnet";
import { LocalRelay } from "../support/relay";
import { desktopNetwork } from "../matrix/desktop";
import { desktopPerson, type DesktopPerson } from "../matrix/people";

/**
 * Two Desktop apps find each other on the Mainline DHT directly, with relay reads off, as the app starts by
 * default ("Also use Pkarr relays" off, apps/desktop/src/pkarr_network.rs): the invite's first contact, the DHT
 * text before the link is live, and the capability records that take the pair live on Iroh or HyperDHT are
 * all read off a DHT of their own (GHOSTLY_PKARR_DHT_BOOTSTRAP, e2e/support/mainlineTestnet.ts). The relay
 * is still written to, for contacts in a browser, which read only relays; the apps never read it.
 *
 * Iroh's relay is out of reach here (`GHOSTLY_IROH_RELAYS` on a closed port, whatever relay the run has), so the pair
 * goes live on HyperDHT from the descriptors in each other's capability record. Before #1404 Iroh homed on n0's relay
 * a few seconds in, and the record went out a third time: that hid that the second one, with the descriptors, was
 * refused by the DHT while the first was still being put (apps/desktop/src/pkarr_network.rs `put_newest`).
 *
 * Neither page may freeze on the way: no gap over a second in its event loop from the invite to the live chat. Each
 * app's first sounds of the chat (the knock, the text, "connected") held the page of WebKitGTK before 2.52 for 5 to 10 s
 * inside `AudioContext.resume()` (r11k, apps/ui/src/lib/sounds.ts `SoundsRelease`).
 */

/** The longest a page may go without running a timer while the pair goes live. */
const MAX_FREEZE_MS = 1_000;

/** How many times the open conversation shows this exact text. */
const count = (p: DesktopPerson, text: string) => p.app.execute<number>(`
  const pane = document.querySelector(".chat-wallpaper");
  return pane ? [...pane.querySelectorAll("*")].filter((e) => e.childElementCount === 0 && e.textContent === arguments[0]).length : 0;`, text);

/** What the connection panel's Details say about discovery: the path, and each relay's state. */
const discovery = (p: DesktopPerson) => p.app.execute<{ path: string | null; relays: string[] }>(`
  return {
    path: document.querySelector('[data-testid="connection-discovery-path"]')?.textContent ?? null,
    relays: [...document.querySelectorAll('[data-testid="connection-relay"]')].map((r) => r.dataset.state),
  };`);

/** Each app's own log (`ghostly.log`, apps/desktop/src/diagnostics.rs): its link-trace lines say how the first text went. */
function attachLogs(name: string, home: string, joined?: number): void {
  const find = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => e.isDirectory() ? find(join(dir, e.name)) : e.name === "ghostly.log" ? [join(dir, e.name)] : []);
  for (const file of find(home)) {
    const log = readFileSync(file);
    void test.info().attach(`${name}'s ghostly.log`, { body: log, contentType: "text/plain" });
    // How long the pair took to go live after the invite was opened: the app's own clock, which is this machine's.
    const ready = /^(\d+) link .*"step":"paired-ready"/m.exec(log.toString())?.[1];
    if (joined && ready) test.info().annotations.push({ type: "live", description: `${name} ${Number(ready) - joined} ms after the join` });
  }
}

test("two Desktop apps pair and go live on the DHT directly, never reading a relay", {
  tag: ["@feature:settings.network.native-dht", "@feature:chat.paired.discovery-health", "@feature:core.dht-direct"],
}, async () => {
  test.setTimeout(10 * 60_000);
  const relay = new LocalRelay();
  const [network, dht] = await Promise.all([desktopNetwork(relay), mainlineTestnet()]);
  const cleanup: (() => Promise<void> | void)[] = [() => relay.close(), () => network.close(), () => dht.close()];
  try {
    const env = { ...network.env, GHOSTLY_PKARR_DHT_BOOTSTRAP: dht.bootstrap, GHOSTLY_IROH_RELAYS: "http://127.0.0.1:9" };
    const join = { at: 0 };
    const open = async (name: string): Promise<DesktopPerson> => {
      const home = desktopHome(name);
      const person = await desktopPerson(name, { home: home.dir, env });
      cleanup.push(async () => { await person.stop(); attachLogs(name, home.dir, join.at); home.remove(); });
      return person;
    };
    const a = await open("ana");
    const b = await open("bia");
    for (const p of [a, b]) await watchEventLoop(p.app);

    await a.press("New chat");
    const invite = await a.copyInvite();
    join.at = Date.now();
    await b.join(invite);
    for (const p of [a, b]) {
      await expect.poll(() => p.canWrite(), { timeout: 120_000, message: `${p.name}'s chat is open` }).toBe(true);
    }
    await a.say("found on the DHT");
    await expect.poll(() => count(b, "found on the DHT"), { timeout: 180_000, message: "bia gets the text" }).toBe(1);
    for (const p of [a, b]) {
      await expect.poll(() => p.connection(), { timeout: 180_000, message: `${p.name} goes live` }).toMatch(/Connected · (Iroh|HyperDHT)/);
    }

    for (const p of [a, b]) {
      expect(await discovery(p), `${p.name}'s panel`).toEqual({ path: "DHT direct", relays: ["ok"] });
    }
    for (const p of [a, b]) {
      const gaps = await longestEventLoopGap(p.app);
      test.info().annotations.push({ type: "event-loop", description: `${p.name} longest gap ${gaps?.longest} ms from ${gaps?.at} (${gaps?.count} over 300 ms)` });
      expect(gaps, `${p.name}'s page was watched throughout`).not.toBeNull();
      // `at` is the app's clock, as ghostly.log's: the link steps just before it say what the page was doing.
      expect(gaps!.longest, `${p.name}'s page froze at ${gaps!.at} (see ${p.name}'s ghostly.log)`).toBeLessThanOrEqual(MAX_FREEZE_MS);
    }
    // Written to, for browser contacts; never read.
    expect(relay.puts, "the apps publish to the relay too").toBeGreaterThan(0);
    expect(relay.gets, "the apps never read the relay").toBe(0);
  } finally {
    for (const done of cleanup.reverse()) await done();
  }
});

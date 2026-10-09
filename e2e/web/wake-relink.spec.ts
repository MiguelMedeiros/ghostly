import type { Browser, Page } from "@playwright/test";
import { endpoints } from "../infra/env.mjs";
import { linkTrace, watchLink } from "../support/callTrace";
import { chat, connect, expect, link, say, test, type Peer } from "../support/fixtures";

/**
 * A chat back from the background is live again in about a second, as after a restart (WISP 100, "Back after a restart",
 * point 6). A phone puts a backgrounded web app to sleep: its process stops, its session dies with nothing said,
 * and it is not restarted, only shown again (`wake`). The contact, its chat not on screen, reads the relays at its
 * background pace (30 s) once it stopped watching for the one that went (`WATCH_PEER_MS`, 2 minutes).
 * Before #1378 the page back waited for that read: live 18 to 92 s after it was shown. Now it resumes on the transport
 * it was live on and knocks on the contact's Iroh relay as its offer goes out: live over the relayed Iroh at once.
 * The knock needs Iroh on both sides, hence the e2e infra's Iroh relay.
 *
 * The page's process is stopped (SIGSTOP), as in #1378's lab. A page frozen over DevTools (`Page.setWebLifecycleState`)
 * runs no script but its WebRTC goes on: the session outlives four minutes of it, and nothing has to come back.
 *
 * The page that sleeps is the one of the two that dials (the lower key): its contact dials nothing and only reads.
 * The other way round, the contact dials for as long as the page is away and reads fast while its offer stands
 * (every 8 s at most): the page back answers that offer and is live at the contact's next read, with #1378 or without.
 */
test.skip(!process.env.GHOSTLY_IROH_RELAY_URL, "Needs the e2e infra's Iroh relay (npm run e2e:infra:use)");
test.skip(process.platform === "win32", "Stops a process with SIGSTOP");

/**
 * From shown again to live on both sides. #1378's lab: 0.4 to 2.2 s. Here 0.6 to 1.3 s, 3.2 s with two of these
 * waking in the same second on a busy machine, and 4.7 s when the page back still holds its dead session: it pings,
 * and lets it go with no answer in `PONG_WAIT_MS` (4 s). Without #1378 it is the contact's next read: 18 s here.
 */
const LIVE_AGAIN_MS = 10_000;
/**
 * Asleep this long: the contact's pings go unanswered and it lets the session go (about a minute), then it stops watching
 * for the page's return (`WATCH_PEER_MS`, 2 minutes) and reads at its background pace.
 */
const AWAY_MS = 4 * 60_000;

/** The page as a browser has it with its tab in the background (headless Chromium keeps every page visible). */
async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((hidden) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event(hidden ? "blur" : "focus"));
  }, hidden);
}

/** Whether the page runs: one whose process is stopped answers nothing. */
const answers = (page: Page) => Promise.race([
  page.evaluate(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
]);

/**
 * The process of `peer`'s page (each person's page has its own: another browser context). DevTools names a browser's
 * processes and the CPU time each has used, not whose page each runs: it is the one two busy seconds in the page show
 * on, well ahead of every other (a busy machine gives the page a part of those seconds only).
 */
async function rendererPid(browser: Browser, peer: Peer): Promise<number> {
  const cdp = await browser.newBrowserCDPSession();
  const used = async () => new Map((await cdp.send("SystemInfo.getProcessInfo")).processInfo.filter((p) => p.type === "renderer").map((p) => [p.id, p.cpuTime]));
  try {
    const tries: string[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await used();
      await peer.page.evaluate(() => { const until = performance.now() + 2_000; while (performance.now() < until); });
      const [busiest, next] = [...await used()].map(([pid, cpu]) => [pid, cpu - (before.get(pid) ?? cpu)] as const).sort((a, b) => b[1] - a[1]);
      if (busiest && busiest[1] >= 0.2 && busiest[1] >= 3 * (next?.[1] ?? 0)) return busiest[0];
      tries.push(`${busiest?.[1].toFixed(2) ?? "-"} s against ${next?.[1].toFixed(2) ?? "-"} s`);
    }
    throw new Error(`no process stood out as running ${peer.name}'s page for two busy seconds: ${tries.join(", ")}`);
  } finally {
    await cdp.detach();
  }
}

/**
 * A person's key as the engine's link trace names it (its first characters), once `watchLink` records the trace.
 * Of two people in a chat, the one with the lower key dials.
 */
async function traceKey(peer: Peer): Promise<string> {
  const handle = await peer.page.waitForFunction(() => {
    for (const line of (globalThis as unknown as { __linkLines?: string[] }).__linkLines ?? []) {
      const me = /"me":"([a-z0-9]+)"/.exec(line)?.[1];
      if (me && me !== "fetch") return me;
    }
    return false;
  }, undefined, { polling: 500, timeout: 60_000 });
  return (await handle.jsonValue()) as string;
}

/**
 * Every label the chat's icon takes from now on, with the time (`Date.now()`) the page showed it. A stopped page runs
 * nothing, so right after it is shown again its icon still says what it said before it went: live. Only a label seen
 * after the session's end tells when the chat is live again.
 */
async function watchIcon(peer: Peer): Promise<void> {
  await peer.page.evaluate(() => {
    const seen: [number, string][] = [];
    (window as unknown as { __iconLabels: [number, string][] }).__iconLabels = seen;
    const note = () => {
      const label = document.querySelector("[data-testid=connection-options]")?.getAttribute("aria-label") ?? "";
      if (label !== seen.at(-1)?.[1]) seen.push([Date.now(), label]);
    };
    note();
    new MutationObserver(note).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-label"] });
  });
}

/** When the chat's icon, having said it is not live (`after` on), says it is live again. */
async function liveAgainAt(peer: Peer, after: number, timeout: number): Promise<number> {
  const handle = await peer.page.waitForFunction((after) => {
    const seen = (window as unknown as { __iconLabels: [number, string][] }).__iconLabels.filter(([at]) => at >= after);
    const down = seen.findIndex(([, label]) => !/Connected/.test(label));
    return down >= 0 && seen.slice(down).find(([, label]) => /Connected/.test(label))?.[0];
  }, after, { polling: 100, timeout });
  return (await handle.jsonValue()) as number;
}

test("a chat back from the background is live again within seconds, and messages go both ways", {
  tag: ["@feature:chat.paired.reconnect", "@feature:core.liveness", "@feature:transport.iroh-web"],
}, async ({ peer, browser, browserName }) => {
  test.skip(browserName !== "chromium", "finding the page's process is Chromium's DevTools protocol");
  test.setTimeout(10 * 60_000);
  const relay = endpoints.irohRelay;
  const [alice, bob] = await Promise.all([peer("alice", { irohRelay: relay }), peer("bob", { irohRelay: relay })]);
  await link(alice, bob);
  await connect(alice, bob);
  await Promise.all([alice, bob].map((p) => watchLink({ kind: "web", ...p })));
  // Both apps run Iroh and told each other: the page back has a transport of the contact's to knock on.
  for (const p of [alice, bob]) {
    await p.page.getByTestId("connection-options").click();
    await expect(p.page.getByTestId("connection-option-iroh")).toBeEnabled({ timeout: 60_000 });
    await p.page.keyboard.press("Escape");
    await expect(p.page.getByTestId("connection-options")).toHaveAttribute("aria-label", /Connected · WebRTC/, { timeout: 60_000 });
  }
  // The one that dials goes to sleep, the other stays.
  const [aliceKey, bobKey] = await Promise.all([traceKey(alice), traceKey(bob)]);
  expect(aliceKey, "two keys alike as far as the trace names them").not.toBe(bobKey);
  const [goes, stays] = aliceKey < bobKey ? [alice, bob] : [bob, alice];

  // The one that stays looks at its chat list: the chat is not on screen, and reads at the background pace.
  const chatUrl = stays.page.url();
  await stays.page.goto("/#/");
  await expect(stays.page.getByTestId("connection-options")).toBeHidden();

  // The other's tab goes to the background and the phone puts it to sleep: its process stops, nothing of it runs.
  await watchIcon(goes);
  const pid = await rendererPid(browser, goes);
  await setHidden(goes.page, true);
  const stopped = Date.now();
  process.kill(pid, "SIGSTOP");
  let shown = 0;
  try {
    expect(await answers(goes.page), `${goes.name}'s page still runs, its process stopped`).toBe(false);
    expect(await answers(stays.page), `${stays.name}'s page runs on`).toBe(true);
    await stays.page.waitForTimeout(AWAY_MS);
  } finally {
    // Shown again.
    process.kill(pid, "SIGCONT");
    shown = Date.now();
  }
  await setHidden(goes.page, false);
  // Its chat hears that the session went, then says live once one is up on both sides (it is authenticated both ways
  // first). The contact stays on its list meanwhile: opening the chat would read the packet of the page back at once,
  // which is not what a contact elsewhere does.
  const live = await liveAgainAt(goes, stopped, 120_000).catch((error: Error) => error);
  for (const p of [alice, bob]) await test.info().attach(`${p.name}-link-trace.txt`, { body: await linkTrace({ kind: "web", ...p }), contentType: "text/plain" });
  const labels = await goes.page.evaluate(() => (window as unknown as { __iconLabels: [number, string][] }).__iconLabels);
  const icon = labels.map(([at, label]) => `${at - shown} ms ${label}`).join("\n");
  await test.info().attach(`${goes.name}-icon.txt`, { body: icon, contentType: "text/plain" });
  console.log(`[wake-relink] ${goes.name}'s icon, from shown again:\n${icon}`);
  if (live instanceof Error) throw live;
  const took = live - shown;
  test.info().annotations.push({ type: "live again", description: `${goes.name} away ${AWAY_MS / 1000} s, shown again: ${took} ms` });
  console.log(`[wake-relink] ${goes.name} shown again after ${AWAY_MS / 1000} s, live again in ${took} ms`);
  expect(took, "from shown again to live").toBeLessThan(LIVE_AGAIN_MS);

  // The contact's chat is live too, and messages go both ways on the session it came back on.
  await stays.page.goto(chatUrl);
  await expect(stays.page.getByTestId("connection-options")).toHaveAttribute("aria-label", /Connected/, { timeout: 5_000 });
  await say(goes, "back from the background");
  await expect(chat(stays).getByText("back from the background")).toBeVisible({ timeout: 15_000 });
  await say(stays, "welcome back");
  await expect(chat(goes).getByText("welcome back")).toBeVisible({ timeout: 15_000 });
});

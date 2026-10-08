import type { Page } from "@playwright/test";
import { endpoints } from "../infra/env.mjs";
import { linkTrace, watchLink } from "../support/callTrace";
import { chat, connect, expect, link, say, test, type Peer } from "../support/fixtures";

/**
 * A chat back from the background is live again in about a second, as after a restart (WISP 100, "Back after a restart",
 * point 6). A phone puts a backgrounded web app to sleep: its page stops running, its session dies with nothing said,
 * and it is not restarted, only shown again (`wake`). The contact, its chat not on screen, reads the relays at its
 * background pace (30 s) once it stopped watching for the one that went (`WATCH_PEER_MS`, 2 minutes).
 * Before #1378 the page back waited for that read: live 18 to 92 s after it was shown. Now it resumes on the transport
 * it was live on and knocks on the contact's Iroh relay as its offer goes out: live over the relayed Iroh at once.
 * The knock needs Iroh on both sides, hence the e2e infra's Iroh relay.
 */
test.skip(!process.env.GHOSTLY_IROH_RELAY_URL, "Needs the e2e infra's Iroh relay (npm run e2e:infra:use)");

/** From shown again to live on both sides (the bar of #1378: about a second, 0.4 to 2.2 s in its lab). */
const LIVE_AGAIN_MS = 2_000;
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

/**
 * Every label the chat's icon takes from now on, with the time (`Date.now()`) the page showed it. A frozen page runs
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

test("a chat back from the background is live again within 2 s, and messages go both ways", {
  tag: ["@feature:chat.paired.reconnect", "@feature:core.liveness", "@feature:transport.iroh-web"],
}, async ({ peer }) => {
  test.setTimeout(10 * 60_000);
  const relay = endpoints.irohRelay;
  const [alice, bob] = await Promise.all([peer("alice", { irohRelay: relay }), peer("bob", { irohRelay: relay })]);
  await link(alice, bob);
  await connect(alice, bob);
  // Both apps run Iroh and told each other: the page back has a transport of the contact's to knock on.
  for (const p of [alice, bob]) {
    await p.page.getByTestId("connection-options").click();
    await expect(p.page.getByTestId("connection-option-iroh")).toBeEnabled({ timeout: 60_000 });
    await p.page.keyboard.press("Escape");
    await expect(p.page.getByTestId("connection-options")).toHaveAttribute("aria-label", /Connected · WebRTC/, { timeout: 60_000 });
  }

  // Alice looks at her chat list: her chat with Bob is not on screen, and reads at the background pace.
  const chatUrl = alice.page.url();
  await alice.page.goto("/#/");
  await expect(alice.page.getByTestId("connection-options")).toBeHidden();

  // Bob's tab goes to the background and the browser freezes it, as a phone does: nothing on the page runs.
  await Promise.all([alice, bob].map((p) => watchLink({ kind: "web", ...p })));
  await watchIcon(bob);
  await setHidden(bob.page, true);
  const cdp = await bob.context.newCDPSession(bob.page);
  const frozen = Date.now();
  await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
  await alice.page.waitForTimeout(AWAY_MS);

  // Shown again.
  await cdp.send("Page.setWebLifecycleState", { state: "active" });
  const shown = Date.now();
  await setHidden(bob.page, false);
  // Bob's chat hears that the session went, then says live once one is up on both sides (it is authenticated both ways
  // first). Alice stays on her list meanwhile: opening the chat would read Bob's packet at once, which is not what a
  // contact elsewhere does.
  const live = await liveAgainAt(bob, frozen, 120_000).catch((error: Error) => error);
  for (const p of [alice, bob]) await test.info().attach(`${p.name}-link-trace.txt`, { body: await linkTrace({ kind: "web", ...p }), contentType: "text/plain" });
  const labels = await bob.page.evaluate(() => (window as unknown as { __iconLabels: [number, string][] }).__iconLabels);
  const icon = labels.map(([at, label]) => `${at - shown} ms ${label}`).join("\n");
  await test.info().attach("bob-icon.txt", { body: icon, contentType: "text/plain" });
  console.log(`[wake-relink] bob's icon, from shown again:\n${icon}`);
  if (live instanceof Error) throw live;
  const took = live - shown;
  test.info().annotations.push({ type: "live again", description: `away ${AWAY_MS / 1000} s, shown again: ${took} ms` });
  console.log(`[wake-relink] bob shown again after ${AWAY_MS / 1000} s, live again in ${took} ms`);
  expect(took, "from shown again to live").toBeLessThan(LIVE_AGAIN_MS);

  // Alice's chat is live too, and messages go both ways on the session it came back on.
  await alice.page.goto(chatUrl);
  await expect(alice.page.getByTestId("connection-options")).toHaveAttribute("aria-label", /Connected/, { timeout: 5_000 });
  await say(bob, "back from the background");
  await expect(chat(alice).getByText("back from the background")).toBeVisible({ timeout: 15_000 });
  await say(alice, "welcome back");
  await expect(chat(bob).getByText("welcome back")).toBeVisible({ timeout: 15_000 });
  await cdp.detach();
});

import type { BrowserContext, Page } from "@playwright/test";
import { chat, expect, test } from "../support/fixtures";
import { seed } from "../support/chatPerf";
import { installIdleProbe, runningAnimations, watchIdle, type IdleReport } from "../support/idle";

/**
 * An app nobody is touching draws nothing. On Linux the Desktop app's window is composited by its own main thread
 * (WebKitGTK), which also goes on drawing a window that is on another workspace: one decoration that loops (the ghost
 * of the empty chat list did, once a second) cost a fifth of a core for as long as the app was open, where the same
 * app with nothing moving costs a thousandth. So, once a screen has settled:
 *
 * - no animation is running, endless or not (what moves when a screen opens ends within seconds);
 * - the page's code asks for no animation frames (a loop would ask for 60 a second; under one a second allows a
 *   one-off, a field revealed as it takes the focus);
 * - no interval is shorter than a second, and no timer callback runs more than twice a second on average (the engine's
 *   housekeeping is a one-second interval and a debounced state push that follows it: about one a second each).
 *
 * A state that can last for hours still moves while it is news (the first minute of a stage of a first pairing, half
 * a minute of a dot that says "connecting"), then rests; and every loop holds still while the window is away.
 */
const WATCH_SECONDS = 10;
/** The probe goes in before the app loads, so the timers the app sets are the counted ones. */
const probed = async (context: BrowserContext) => { await context.addInitScript(installIdleProbe); };

// A trace's DOM snapshots and a video's frames would be counted with the app.
test.use({ trace: "off", video: "off" });

function expectQuiet(report: IdleReport, screen: string) {
  console.log(`idle (${screen}): ${report.framesPerSecond.toFixed(1)} frame callbacks/s, ${report.timersPerSecond.toFixed(1)} timer callbacks/s; busiest: ${report.busiest.slice(0, 3).join(" | ")}`);
  expect(report.running, `${screen}: animations still running`).toEqual([]);
  expect(report.framesPerSecond, `${screen}: animation frames asked for by ${Object.keys(report.frameSites).join(" | ")}`).toBeLessThan(1);
  expect(report.fastIntervals, `${screen}: intervals under a second`).toEqual([]);
  const busy = Object.entries(report.timerSites).filter(([, runs]) => runs > 2 * report.seconds).map(([site, runs]) => `${runs}x ${site}`);
  expect(busy, `${screen}: timers that run more than twice a second`).toEqual([]);
}

/** What opening a screen moves (a fade, the ghost's few boos, the logo's motion) has ended. */
const settled = (page: Page) => expect.poll(() => runningAnimations(page), { timeout: 20_000 }).toEqual([]);

/** The window goes behind another one, or comes back: what the page hears then, since a test's window always has the focus. */
async function setWindowAway(page: Page, away: boolean): Promise<void> {
  await page.evaluate((away) => {
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => !away });
    window.dispatchEvent(new Event(away ? "blur" : "focus"));
  }, away);
  if (away) await expect(page.locator("html")).toHaveAttribute("data-away");
  else await expect(page.locator("html")).not.toHaveAttribute("data-away");
}

test("the welcome screen and the chat list draw nothing once they have settled", { tag: ["@feature:app.idle", "@feature:app.home"] }, async ({ peer }) => {
  const alice = await peer("idle-alice", { beforeOpen: probed });
  const page = alice.page;

  // A new profile: the welcome screen beside the empty chat list, whose ghost says boo a few times and rests.
  await expect(page.getByText("It's quiet here...")).toBeVisible();
  await expect(page.getByTestId("home-chat-actions")).toBeVisible();
  await settled(page);
  expectQuiet(await watchIdle(page, WATCH_SECONDS), "welcome screen, new profile");

  // The same profile with chats: the chat list beside the welcome screen. Their contacts never answer, so every
  // chat keeps looking for its contact in the background, as chats do while a contact is away.
  await seed(page, [{ label: "One", count: 30, lean: true }, { label: "Two", count: 8, lean: true }, { label: "Three", count: 3, lean: true }]);
  await page.reload();
  await expect(page.getByTestId("chat-row-name").filter({ hasText: "One" })).toBeVisible();
  await expect(page.getByTestId("chat-row")).toHaveCount(3);
  await settled(page);
  expectQuiet(await watchIdle(page, WATCH_SECONDS), "chat list, three chats");
});

test("a pairing nobody answers moves for a minute, rests, and holds still while the window is away", { tag: ["@feature:app.idle", "@feature:chat.paired.pairing-progress"] }, async ({ peer }) => {
  const alice = await peer("idle-alice", { beforeOpen: probed });
  const page = alice.page;

  // A new chat: the pairing scene and the header's glyph say the invite waits for the contact, with loops.
  await page.getByTitle("New Chat").click();
  await expect(chat(alice)).toBeVisible();
  const scene = page.getByTestId("pairing-scene"), glyph = page.getByTestId("pairing-glyph").first();
  await expect(scene).toHaveAttribute("data-stage", "waiting");
  await expect.poll(() => runningAnimations(page, "endless")).not.toEqual([]);

  // Behind another window (or on another workspace, where WebKitGTK goes on drawing): every loop holds still.
  await setWindowAway(page, true);
  await expect(scene).toHaveAttribute("data-paused", "true");
  await expect.poll(() => runningAnimations(page, "endless")).toEqual([]);
  await setWindowAway(page, false);
  await expect(scene).not.toHaveAttribute("data-paused");
  await expect.poll(() => runningAnimations(page, "endless")).not.toEqual([]);

  // Nobody opens the invite: after a minute in the same stage the scene and the glyph are still pictures.
  await expect(scene).toHaveAttribute("data-still", "true", { timeout: 90_000 });
  await expect(glyph).toHaveAttribute("data-still", "true");
  await expect(scene).toHaveAttribute("data-stage", "waiting");
  await expect.poll(() => runningAnimations(page, "endless")).toEqual([]);
  // The scene's clock still counts the seconds, and the field's caret blinks: neither is the page's code asking for frames.
  const report = await watchIdle(page, WATCH_SECONDS);
  expect(report.endless, "loops running in a chat whose invite nobody opened").toEqual([]);
  expect(report.framesPerSecond).toBeLessThan(1);
  expect(report.fastIntervals).toEqual([]);
});

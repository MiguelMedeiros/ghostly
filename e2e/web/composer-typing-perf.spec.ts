import type { Page } from "@playwright/test";
import { chat, expect, test } from "../support/fixtures";
import { history, seed } from "../support/chatPerf";
import { instrumentTyping, typeAndMeasure, type Typing } from "../support/typingPerf";
import { pair } from "../support/paired";

/**
 * Typing in a long chat costs what it costs in a short one: a keystroke draws the composer, never the chat's messages,
 * and the field grows without laying the whole chat out again. A chat of 600 mixed messages is compared with one of 20,
 * 200 characters typed into each, and again with the processor slowed 4x (a busy machine).
 *
 *   PERF_LOG=1 E2E_WEB_URL=http://localhost:<port> npx playwright test -c e2e/playwright.config.ts --project web composer-typing-perf
 *
 * prints the numbers; PERF_PAIRED=1 adds a paired chat whose contact's typing indicator comes and goes meanwhile, as a
 * bot's "thinking..." does (a real pairing: slower). Absolute times depend on the machine and its load: the test holds
 * generous bounds only.
 */
const TEXT = "Olha isso: the composer should stay quick while a long chat sits above it, even when the machine is busy with builds and a bot keeps thinking. ";
const typed = (n: number) => TEXT.repeat(Math.ceil(n / TEXT.length)).slice(0, n);

// A trace's DOM snapshots and a video would be measured with the app.
test.use({ trace: "off", video: "off" });

async function throttle(page: Page, rate: number): Promise<void> {
  if (page.context().browser()?.browserType().name() !== "chromium") return;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
}

const log = (label: string, numbers: Record<string, Typing>) => {
  if (process.env.PERF_LOG) console.log(`composer-typing-perf ${label}: ${JSON.stringify(numbers, null, 1)}`);
};

test("typing in a long chat draws no message rows and costs what it does in a short one", { tag: ["@feature:app.composer.typing-cost"] }, async ({ peer }) => {
  test.setTimeout(5 * 60_000);
  const bob = await peer("typing-bob");
  await bob.context.addInitScript(instrumentTyping);
  await seed(bob.page, [{ label: "Long chat", count: 600 }, { label: "Short chat", count: 20 }]);
  await bob.page.reload();
  await expect(bob.page.getByTestId("chat-row-name").filter({ hasText: "Long chat" })).toBeVisible();

  // No `:has()` rule anchored on `.group`: every message row is one, and WebKit then pays for each keystroke (and any
  // other change of the page) in proportion to the chat's length. Rules inside @layer and @media are read too.
  const groupHas = await bob.page.evaluate(() => {
    const found: string[] = [];
    const walk = (rules: CSSRuleList) => {
      for (const rule of rules) {
        const selector = (rule as CSSStyleRule).selectorText;
        if (selector && /\.group\b[^,]*:has\(/.test(selector)) found.push(selector);
        if ((rule as CSSGroupingRule).cssRules) walk((rule as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of document.styleSheets) { try { walk(sheet.cssRules); } catch { /* another origin's */ } }
    return found;
  });
  expect(groupHas).toEqual([]);

  const open = async (label: string) => {
    await bob.page.getByTestId("chat-row-name").filter({ hasText: label }).click();
    await expect(chat(bob).locator("[data-message-row]").last()).toBeInViewport();
    await bob.page.waitForTimeout(800);
  };
  const results: Record<string, Typing> = {};
  for (const rate of [1, 4]) {
    await throttle(bob.page, rate);
    for (const label of ["Short chat", "Long chat"]) {
      await open(label);
      // Rows counted on a short run (walking React's tree costs time of its own), then the latency on 200 keys.
      results[`${label} ${rate}x rows`] = await typeAndMeasure(bob.page, typed(30), { countRows: true });
      results[`${label} ${rate}x`] = await typeAndMeasure(bob.page, typed(200));
    }
  }
  await throttle(bob.page, 1);
  log("seeded", results);

  for (const label of ["Short chat", "Long chat"]) for (const rate of [1, 4]) {
    // Message rows are not drawn again for keystrokes (a row the engine changed meanwhile may be; every row of the
    // long chat drawn once would be 20 per keystroke here).
    expect(results[`${label} ${rate}x rows`].rows, `${label} ${rate}x rows`).toBeLessThan(5);
    // The field grows a line at a time as the text wraps, and is left alone in between: it was four writes per
    // keystroke (about 800 here).
    expect(results[`${label} ${rate}x`].heightWrites, `${label} ${rate}x height writes`).toBeLessThanOrEqual(8);
  }
  // Generous on purpose (a loaded runner): 30 times the messages may not make a keystroke cost 3 times more.
  const long = results["Long chat 4x"], short = results["Short chat 4x"];
  expect(long.median).toBeLessThan(Math.max(50, short.median * 3));
});

test("a keystroke in a long chat does not paint its message list again", { tag: ["@feature:app.composer.typing-cost"] }, async ({ peer, browserName }) => {
  test.skip(browserName !== "chromium", "counts paints in a Chromium trace");
  test.setTimeout(3 * 60_000);
  const bob = await peer("paint-bob");
  await seed(bob.page, [{ label: "Long chat", count: 600 }]);
  await bob.page.reload();
  // Still: the connection icon of a chat never paired is an animation, painted every frame.
  await bob.page.emulateMedia({ reducedMotion: "reduce" });
  await bob.page.getByTestId("chat-row-name").filter({ hasText: "Long chat" }).click();
  await expect(chat(bob).locator("[data-message-row]")).toHaveCount(600);
  const box = bob.page.getByPlaceholder("Message…");
  await box.click();
  await bob.page.waitForTimeout(500);

  const cdp = await bob.context.newCDPSession(bob.page);
  const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "[data-message-list]" });
  const { node } = await cdp.send("DOM.describeNode", { nodeId });
  const events: { name: string; ph: string; args?: { data?: { nodeId?: number } } }[] = [];
  cdp.on("Tracing.dataCollected", ({ value }) => events.push(...(value as unknown as typeof events)));
  await cdp.send("Tracing.start", { categories: "devtools.timeline", transferMode: "ReportEvents" });
  await box.pressSequentially(typed(20), { delay: 60 });
  await bob.page.waitForTimeout(300);
  const complete = new Promise(done => cdp.once("Tracing.tracingComplete", done));
  await cdp.send("Tracing.end");
  await complete;
  const paints = events.filter(e => e.name === "Paint" && e.args?.data?.nodeId === node.backendNodeId).length;
  if (process.env.PERF_LOG) console.log(`composer-typing-perf list paints for 20 keys: ${paints}`);
  // The list's size is its own (`contain: size`): a keystroke laid the composer's column out again, and Chromium painted
  // all 600 rows with it, once per key (a 600-row list: 3 ms a key, 30 at 4x).
  expect(paints).toBeLessThan(5);
});

/** A paired chat whose contact's typing indicator comes and goes every second, with 600 messages seeded above it. */
test("a contact's typing indicator coming and going does not draw a long chat again", { tag: ["@feature:app.composer.typing-cost"] }, async ({ peer }) => {
  test.skip(!process.env.PERF_PAIRED, "a measurement: PERF_PAIRED=1 runs it");
  test.setTimeout(6 * 60_000);
  const [alice, bob] = await Promise.all([peer("thinking-alice"), peer("typing-bob")]);
  await bob.context.addInitScript(instrumentTyping);
  await pair(alice, bob);
  // Bob's chat gets a long history, older than what was said.
  await bob.page.evaluate((messages) => {
    const key = Object.keys(localStorage).find(k => /^ghostly_[0-9a-f]{32}$/.test(k))!;
    const session = JSON.parse(localStorage.getItem(key)!);
    session.messages = [...messages, ...session.messages];
    localStorage.setItem(key, JSON.stringify(session));
  }, history(600, Date.now() - 30 * 86_400_000));
  await bob.page.reload();
  await bob.page.getByTestId("chat-row").first().click();
  await expect.poll(() => chat(bob).locator("[data-message-row]").count(), { timeout: 30_000 }).toBeGreaterThan(600);
  await expect(bob.page.getByTestId("connection-options")).toHaveAccessibleName(/Connected · /, { timeout: 90_000 });

  // Alice writes a letter and takes it back, every second: Bob sees "typing…" come and go.
  const aliceBox = alice.page.getByPlaceholder("Message…");
  let on = true;
  const flicker = (async () => {
    while (on) {
      await aliceBox.fill("h");
      await alice.page.waitForTimeout(600);
      await aliceBox.fill("");
      await alice.page.waitForTimeout(600);
    }
  })();
  await expect(bob.page.getByTestId("chat-typing")).toBeVisible({ timeout: 15_000 });

  const results: Record<string, Typing> = {};
  for (const rate of [1, 4]) {
    await throttle(bob.page, rate);
    results[`${rate}x rows`] = await typeAndMeasure(bob.page, typed(60), { countRows: true });
    results[`${rate}x`] = await typeAndMeasure(bob.page, typed(200));
  }
  await throttle(bob.page, 1);
  on = false;
  await flicker;
  log("paired, contact typing", results);

  // The indicator redraws the header, never the 600 rows.
  expect(results["1x rows"].rows).toBeLessThan(5);
  expect(results["4x rows"].rows).toBeLessThan(5);
  expect(results["4x"].median).toBeLessThan(50);
});


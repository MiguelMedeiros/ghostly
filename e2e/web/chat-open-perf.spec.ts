import { chat, expect, test } from "../support/fixtures";
import { countCommits, openAndMeasure, seed, summary, type Open } from "../support/chatPerf";
import type { Page } from "@playwright/test";

/**
 * How long a long chat takes to open: from the click on its row in the chat list to its first message painted, and to
 * the list settled at its bottom, with the main thread's long tasks and React's commits on the way. A chat of 5,000
 * mixed messages (formatting, links with previews, pictures, voice notes, videos, a bot's status cards, replies,
 * reactions, edits, forwards) is compared with one of 50, opened in turn.
 *
 *   PERF_RUNS=5 E2E_WEB_URL=http://localhost:<port> npx playwright test -c e2e/playwright.config.ts --project web chat-open-perf
 *
 * prints the median of each number. Absolute times depend on the machine and its load: compare builds run by run
 * (interleaved), not against a number from another day. By itself the test only holds a generous bound: a chat 100
 * times longer may cost more to open, but not in proportion.
 */

const RUNS = Number(process.env.PERF_RUNS) || 3;
/** Most message rows a chat has in the page (apps/ui/src/hooks/useRowWindow.ts `MAX_ROWS`). */
const MAX_ROWS = 300;
/** Rows a chat opens with (`OPEN_ROWS`). */
const OPEN_ROWS = 100;

// A trace's DOM snapshots and a video would be measured with the app.
test.use({ trace: "off", video: "off" });

test("a long chat opens without costing in proportion to its length", { tag: ["@feature:chat.scroll"] }, async ({ peer }) => {
  test.setTimeout(5 * 60_000);
  const bob = await peer("perf-bob");
  await bob.context.addInitScript(countCommits);
  await seed(bob.page, [{ label: "Long chat", count: 5_000 }, { label: "Short chat", count: 50 }]);
  // Seeded after load: a reload hands the hook to React, and shows the chats.
  await bob.page.reload();
  await expect(bob.page.getByTestId("chat-row-name").filter({ hasText: "Long chat" })).toBeVisible();

  const home = async () => {
    await bob.page.evaluate(() => { location.hash = "/"; });
    await expect(chat(bob)).toHaveCount(0);
    // Let the page go quiet before the next click.
    await bob.page.waitForTimeout(600);
  };
  const runs: Record<string, Open[]> = { "Long chat": [], "Short chat": [] };
  // A first open of each warms the code paths (lazy chunks, the parser's grammars) and is not counted.
  for (let run = -1; run < RUNS; run++) {
    for (const label of run % 2 ? ["Long chat", "Short chat"] : ["Short chat", "Long chat"]) {
      await home();
      const open = await bob.page.evaluate(openAndMeasure, label);
      await expect(chat(bob).locator("[data-message-row]").last()).toBeInViewport();
      if (run >= 0) runs[label].push(open);
    }
  }
  const long = summary(runs["Long chat"]), short = summary(runs["Short chat"]);
  console.log(`chat-open-perf (median of ${RUNS}): ${JSON.stringify({ long, short })}`);
  for (const [label, opens] of Object.entries(runs)) console.log(`  ${label}: ${opens.map(o => JSON.stringify(o)).join("\n    ")}`);

  // Its last rows are in the page, never the whole history, and the view never left the bottom.
  expect(long.rows).toBe(OPEN_ROWS);
  expect(long.offBottom).toBe(0);
  // Generous on purpose (a loaded CI runner). Before the window of rows, 5,000 messages took 6.5 s to settle here (every
  // row drawn above, 150 at a time), against ~100 ms after.
  expect(long.settled).toBeLessThan(Math.max(1_500, short.settled * 5));
  expect(long.paint).toBeLessThan(Math.max(400, short.paint * 5));
  // Open and left alone, a long chat does no long work (each change of the page used to draw every bubble again).
  expect(long.idleLong).toBeLessThan(150);
});

test("leaving a long chat costs what leaving a short one does", { tag: ["@feature:app.navigation"] }, async ({ peer }) => {
  test.setTimeout(5 * 60_000);
  const bob = await peer("switch-bob");
  await bob.context.addInitScript(countCommits);
  await seed(bob.page, [{ label: "Long chat", count: 600 }, { label: "Short chat", count: 20 }, { label: "Other chat", count: 20 }]);
  await bob.page.reload();
  await expect(bob.page.getByTestId("chat-row-name").filter({ hasText: "Long chat" })).toBeVisible();
  // A slower processor: the long chat is still drawing its older rows when it is left, however fast the runner.
  const cdp = await bob.context.newCDPSession(bob.page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const open = async (label: string) => {
    const opened = await bob.page.evaluate(openAndMeasure, label);
    await expect(chat(bob).locator("[data-message-row]").last()).toBeInViewport();
    return opened;
  };
  await open("Short chat");
  const leaveLong: Open[] = [], leaveShort: Open[] = [];
  // From one chat to another in the chat list, as a person goes back and forth; the first round warms the code paths.
  for (let run = -1; run < RUNS; run++) {
    await open("Long chat");
    const fromLong = await open("Short chat");
    const fromShort = await open("Other chat");
    if (run >= 0) { leaveLong.push(fromLong); leaveShort.push(fromShort); }
    await open("Short chat");
  }
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  const long = summary(leaveLong), short = summary(leaveShort);
  console.log(`chat-switch-perf, 4x slower (median of ${RUNS}): ${JSON.stringify({ long, short })}`);
  // Before, the move to the next chat was a transition: each change of the engine's state (a sync render, several a
  // second) started it over, and it waited behind the long chat's older rows (1.1 to 1.7 s here, against 0.3 s).
  expect(long.paint).toBeLessThan(Math.max(700, short.paint * 2));
});

test("the message list is a layer of its own, but not while a video in it plays full screen", { tag: ["@feature:chat.scroll"] }, async ({ peer }) => {
  const bob = await peer("layer-bob");
  await seed(bob.page, [{ label: "Short chat", count: 50 }]);
  await bob.page.reload();
  await bob.page.getByTestId("chat-row-name").filter({ hasText: "Short chat" }).click();
  const list = chat(bob);
  await expect(list.locator("[data-message-row]").first()).toBeAttached();
  await expect.poll(() => list.evaluate(el => getComputedStyle(el).willChange)).toBe("transform");
  // Full screen, a video is `position: fixed`: a layer would hold it inside the list.
  await list.evaluate(el => el.querySelector("[data-message-row]")!.setAttribute("data-theater", "true"));
  await expect.poll(() => list.evaluate(el => getComputedStyle(el).willChange)).toBe("auto");
});

/** The chat's rows in the page: how many, and the first and last ids. */
const inPage = (page: Page) => chat({ page } as never).evaluate(el => {
  const rows = [...el.querySelectorAll<HTMLElement>("[data-message-id]")];
  return { rows: rows.length, first: rows[0]?.dataset.messageId, last: rows.at(-1)?.dataset.messageId };
});

test("scrolled up, a long chat's older messages come into the page above without moving the view, and never all of them", { tag: ["@feature:chat.scroll"] }, async ({ peer }) => {
  test.setTimeout(3 * 60_000);
  const bob = await peer("perf-scroll-bob");
  await seed(bob.page, [{ label: "Long chat", count: 5_000 }]);
  await bob.page.reload();
  await bob.page.getByTestId("chat-row-name").filter({ hasText: "Long chat" }).click();
  await expect(chat(bob).locator("[data-message-row]").last()).toBeInViewport();
  expect((await inPage(bob.page)).rows).toBe(OPEN_ROWS);

  // A hand scrolls two screens at a time, as a wheel would, and rows come into the page and leave it at the edges: the
  // row at the top of the view stays where it was, to the pixel.
  const scroll = (views: number) => chat(bob).evaluate(async (el, views) => {
    const edges = () => { const rows = el.querySelectorAll<HTMLElement>("[data-message-id]"); return `${rows[0].dataset.messageId}|${rows[rows.length - 1].dataset.messageId}`; };
    const top = el.getBoundingClientRect().top;
    el.scrollTop = Math.max(0, el.scrollTop + views * el.clientHeight);
    const row = [...el.querySelectorAll<HTMLElement>("[data-message-id]")].find(r => r.getBoundingClientRect().bottom > top + 1)!;
    const id = row.dataset.messageId!, y = row.getBoundingClientRect().top;
    const before = edges();
    const at = () => el.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)?.getBoundingClientRect().top ?? Infinity;
    // Where the row is each time the list's content changes size, as it will be painted: this observer is made after the
    // app's own, so it sees the view once the app has put it back (reading it in a frame callback would force a layout
    // before the app has had its turn).
    let drift = 0;
    const watcher = new ResizeObserver(() => { drift = Math.max(drift, Math.abs(at() - y)); });
    watcher.observe(el.firstElementChild!);
    // The scroll event, the rows it brings, and what they load (pictures, previews).
    for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame);
    watcher.disconnect();
    return { moved: edges() !== before, drift: Math.max(drift, Math.abs(at() - y)), rows: el.querySelectorAll("[data-message-id]").length };
  }, views);
  let loads = 0, most = 0;
  for (let step = 0; step < 600 && (await inPage(bob.page)).first !== "me_r000000ab"; step++) {
    const up = await scroll(-2);
    if (up.moved) expect(up.drift, `the view moved when older rows came in (load ${++loads})`).toBeLessThan(1);
    most = Math.max(most, up.rows);
  }
  // Up to the very first message, a page at a time, never more than the window in the page.
  expect((await inPage(bob.page)).first).toBe("me_r000000ab");
  expect(loads).toBeGreaterThan(40);
  expect(most).toBeLessThanOrEqual(MAX_ROWS);
  // Down again: newer rows come in below and the top ones leave the page, above the view, which does not move.
  let downs = 0;
  for (let step = 0; step < 60 && downs < 5; step++) {
    const down = await scroll(2);
    if (down.moved) expect(down.drift, `the view moved when rows left the page above it (${++downs})`).toBeLessThan(1);
    expect(down.rows).toBeLessThanOrEqual(MAX_ROWS);
  }
  expect(downs).toBe(5);
  // Up there, the ↓ takes the view back to the last message.
  await bob.page.getByTestId("jump-latest").click();
  await expect(chat(bob).locator("[data-message-id=peer_r004999ab]")).toBeInViewport();
});

test("a quote in a long chat goes to its original far up the history, not in the page", { tag: ["@feature:chat.scroll", "@feature:chat.replies"] }, async ({ peer }) => {
  const bob = await peer("perf-quote-bob");
  await seed(bob.page, [{ label: "Long chat", count: 5_000 }]);
  await bob.page.reload();
  await bob.page.getByTestId("chat-row-name").filter({ hasText: "Long chat" }).click();
  // The last message quotes the first, 5,000 messages up.
  const last = chat(bob).locator("[data-message-id=peer_r004999ab]");
  await expect(last).toBeInViewport();
  await expect(chat(bob).locator("[data-message-id=me_r000000ab]")).toHaveCount(0);
  await last.getByTestId("message-quote").click();
  const original = chat(bob).locator("[data-message-id=me_r000000ab]");
  await expect(original).toHaveAttribute("data-reply-flash", "");
  await expect(original).toBeInViewport();
  expect((await inPage(bob.page)).rows).toBeLessThanOrEqual(MAX_ROWS);
  await expect(bob.page.getByTestId("reply-quote-note")).toHaveCount(0);
});

test("a long chat follows new messages at its bottom, and counts them from up the history", { tag: ["@feature:chat.scroll"] }, async ({ peer }) => {
  const bob = await peer("perf-follow-bob");
  const [id] = await seed(bob.page, [{ label: "Long chat", count: 5_000 }]);
  await bob.page.reload();
  await bob.page.getByTestId("chat-row-name").filter({ hasText: "Long chat" }).click();
  await expect(chat(bob).locator("[data-message-id=peer_r004999ab]")).toBeInViewport();
  // The contact's new message, as the engine stores it.
  const arrive = (n: number) => bob.page.evaluate(({ id, n }) => {
    const key = `ghostly_${id}`;
    const session = JSON.parse(localStorage.getItem(key)!);
    session.messages.push({ id: `peer_new${n}`, ref: `new${n}`, sender: "peer", timestamp: Date.now(), text: `Fresh news ${n}` });
    localStorage.setItem(key, JSON.stringify(session));
    window.dispatchEvent(new Event("session-updated"));
  }, { id, n });
  await arrive(1);
  await expect(chat(bob).locator("[data-message-id=peer_new1]")).toBeInViewport();
  await expect(bob.page.getByTestId("jump-latest")).toHaveCount(0);

  // Far up the history, the last rows are not in the page: a new one is counted, and the pill goes to it.
  await chat(bob).locator("[data-message-id=peer_r004999ab]").getByTestId("message-quote").click();
  await expect(chat(bob).locator("[data-message-id=me_r000000ab]")).toBeInViewport();
  await arrive(2);
  await expect(bob.page.getByTestId("jump-latest")).toHaveAttribute("data-count", "1");
  await expect(chat(bob).locator("[data-message-id=peer_new2]")).toHaveCount(0);
  await bob.page.getByTestId("jump-latest").click();
  await expect(chat(bob).locator("[data-message-id=peer_new2]")).toBeInViewport();
  expect((await inPage(bob.page)).rows).toBeLessThanOrEqual(MAX_ROWS);
});

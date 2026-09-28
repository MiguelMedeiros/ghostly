import { createLink } from "@ghostly/core";
import { chat, connect, expect, link, say, test, WAYBACK, type Peer } from "../support/fixtures";

/**
 * Scrolled up in a chat, the contact's new messages do not move the view: Bob keeps reading where he was and a "↓ 3 new"
 * pill counts them, then takes him down. What Bob sends himself always goes to the bottom.
 */

const pill = (p: Peer) => p.page.getByTestId("jump-latest");
const scrollTop = (p: Peer) => chat(p).evaluate(el => el.scrollTop);
const distanceToBottom = (p: Peer) => chat(p).evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight);

test("scrolled up, new messages keep the view and a pill counts them", { tag: ["@feature:chat.scroll"] }, async ({ peer }, testInfo) => {
  test.setTimeout(4 * 60_000);
  const [alice, bob] = await Promise.all([peer("scroll-alice"), peer("scroll-bob")]);
  await link(alice, bob);
  await connect(alice, bob);

  // A history taller than the view: at the bottom, each one keeps Bob there.
  for (let i = 1; i <= 10; i++) await say(alice, `Page ${i}\n${"line\n".repeat(5)}end`);
  await expect(chat(bob).getByText("Page 10", { exact: false })).toBeInViewport();
  expect(await distanceToBottom(bob)).toBeLessThan(100);
  await expect(pill(bob)).toHaveCount(0);

  // Bob scrolls to the top and reads the first page.
  await chat(bob).evaluate(el => { el.scrollTop = 0; });
  const first = chat(bob).getByText(`hello from ${alice.name}`);
  await expect(first).toBeInViewport();
  const before = (await first.boundingBox())!.y;
  await expect(pill(bob)).toHaveAttribute("data-count", "0");

  for (const text of ["New 1", "New 2", "New 3"]) await say(alice, text);
  await expect(chat(bob).getByText("New 3", { exact: true })).toBeAttached();
  await expect(pill(bob)).toHaveAttribute("data-count", "3");
  await expect(pill(bob)).toHaveAccessibleName("3 new messages, scroll to bottom");
  await expect(pill(bob)).toContainText("3 new");
  expect(await scrollTop(bob)).toBe(0);
  expect((await first.boundingBox())!.y).toBeCloseTo(before, 0);
  await expect(chat(bob).getByText("New 3", { exact: true })).not.toBeInViewport();
  await bob.page.screenshot({ path: testInfo.outputPath("new-messages-pill.png") });

  // On a phone: a round button, the count a badge on it.
  const desktop = bob.page.viewportSize()!;
  await bob.page.setViewportSize({ width: 390, height: 844 });
  await expect(pill(bob).getByTestId("jump-latest-label")).toBeHidden();
  await expect(pill(bob)).toContainText("3");
  await bob.page.screenshot({ path: testInfo.outputPath("new-messages-pill-phone.png") });
  await bob.page.setViewportSize(desktop);

  await pill(bob).click();
  await expect(chat(bob).getByText("New 3", { exact: true })).toBeInViewport();
  await expect(pill(bob)).toHaveCount(0);

  // Scrolled up again, Bob's own message takes him to the bottom.
  await chat(bob).evaluate(el => { el.scrollTop = 0; });
  await expect(pill(bob)).toBeVisible();
  await say(bob, "Found it");
  await expect(chat(bob).getByText("Found it", { exact: true })).toBeInViewport();
  await expect(pill(bob)).toHaveCount(0);
});

/**
 * A long chat with pictures and videos, left and opened again: it opens on its last message, whole, after the pictures
 * loaded above it (the open's own scroll event used to read as scrolling up). One left scrolled up opens on the same
 * message.
 */

/** A picture 320 × 240, served late: it lays out after the chat has opened at its bottom. */
const PICTURE = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#7c5cff"/></svg>`;

test("a long chat with pictures and videos opens again on its last message", { tag: ["@feature:chat.scroll"] }, async ({ peer }) => {
  test.setTimeout(2 * 60_000);
  const bob = await peer("reopen-bob");
  let served = 0;
  await bob.context.route(WAYBACK, async route => {
    await new Promise(done => setTimeout(done, 150 + (served++ % 5) * 120));
    await route.fulfill({ status: 200, contentType: "image/svg+xml", body: PICTURE });
  });

  const chats = [createLink().mine, createLink().mine];
  const ids = await bob.page.evaluate(chats => chats.map((mine, c) => {
    const id = crypto.randomUUID().replaceAll("-", "");
    const start = Date.now() - 86_400_000;
    const messages = Array.from({ length: c === 0 ? 200 : 20 }, (_, i) => {
      const peer = i % 3 !== 0;
      const base = { id: `${peer ? "peer" : "me"}_${c}_${i}`, sender: peer ? "peer" : "me", timestamp: start + i * 60_000, delivery: peer ? undefined : "delivered" };
      if (c === 0 && i % 8 === 4) return { ...base, id: `peer_${c}_${i}`, sender: "peer", delivery: undefined, text: `https://web.archive.org/web/2009/http://geocities.com/ghost${i}.gif` };
      if (c === 0 && i % 40 === 20) {
        return { ...base, text: "", file: { id: `video${i}`, name: `ghosts${i}.mp4`, size: 400_000, mime: "video/mp4", video: { duration: 4000, width: 640, height: 360 } } };
      }
      const text = i === 199 ? "The last message\nwith a second line\nand a third" : i % 5 === 0 ? `Message ${i}\n${"a longer line of text\n".repeat(4)}end` : `Message ${i}`;
      return { ...base, text };
    });
    localStorage.setItem(`ghostly_${id}`, JSON.stringify({ id, mySeedB64: mine.seedB64, peerPubKeyB64: mine.peerPubKeyZ32, encKeyB64: mine.encKeyB64, messages, createdAt: start }));
    return id;
  }), chats);
  await bob.page.evaluate(() => window.dispatchEvent(new Event("session-updated")));

  const open = (id: string) => bob.page.evaluate(id => { location.hash = `/chat/${id}`; }, id);
  const last = chat(bob).getByText("The last message", { exact: false });
  const atBottom = () => expect.poll(() => distanceToBottom(bob), { timeout: 10_000 }).toBeLessThanOrEqual(2);

  await open(ids[0]);
  await expect(last).toBeVisible();
  await atBottom();

  // Away to the other chat and back, twice: each time the pictures load again after the open.
  for (let round = 0; round < 2; round++) {
    await open(ids[1]);
    await expect(chat(bob).getByText("Message 19", { exact: true })).toBeVisible();
    await open(ids[0]);
    await expect(last).toBeVisible();
    await atBottom();
    await expect(last).toBeInViewport({ ratio: 1 });
    // Every picture near the bottom has come in and laid out, and the view is still on the last message.
    await expect.poll(() => chat(bob).locator("img[src*='web.archive.org']").evaluateAll(imgs =>
      imgs.filter(img => img.getBoundingClientRect().bottom > 0 && !(img as HTMLImageElement).complete).length)).toBe(0);
    await atBottom();
  }
  expect(served).toBeGreaterThan(0);

  // Left scrolled up, it opens on the same message, where it was in the view.
  await chat(bob).evaluate(el => { el.scrollTop = el.scrollHeight / 2; });
  const shown = await chat(bob).locator("[data-message-id]").evaluateAll(rows => {
    const top = rows[0].closest(".chat-wallpaper")!.getBoundingClientRect().top;
    const row = rows.find(row => row.getBoundingClientRect().top > top + 40)!;
    return { id: row.getAttribute("data-message-id")!, y: row.getBoundingClientRect().top };
  });
  await open(ids[1]);
  await expect(chat(bob).getByText("Message 19", { exact: true })).toBeVisible();
  await open(ids[0]);
  const row = chat(bob).locator(`[data-message-id="${shown.id}"]`);
  await expect(row).toBeInViewport();
  await expect.poll(async () => Math.round((await row.boundingBox())!.y)).toBeCloseTo(shown.y, -1);
  expect(await distanceToBottom(bob)).toBeGreaterThan(400);
});

/**
 * Sending shows no scrollbar. The bubble that arrives slides in from its side, and that slide used to make the list
 * scroll sideways for a few frames: a horizontal scrollbar where scrollbars take room, the view jumping by its height,
 * macOS flashing its scrollers. Sampled on every frame while a message goes, in a short chat (nothing to scroll at all)
 * and a long one (the view only goes down, to the bottom). Narrow columns only: at 1280 the column has room around it.
 */

interface Frame { sw: number; cw: number; sh: number; ch: number; top: number; rows: number }

/**
 * Seeds a chat of `count` messages straight into storage and opens it. A chat this side joined long ago: its "joined"
 * went out then, so opening it adds no row (one that never said it adds "joined the chat" once its link is up, after
 * the count below had passed or not).
 */
async function seedChat(p: Peer, count: number) {
  const mine = createLink().mine;
  await p.page.evaluate(({ mine, count }) => {
    const id = crypto.randomUUID().replaceAll("-", "");
    const start = Date.now() - 86_400_000;
    const messages = Array.from({ length: count }, (_, i) => ({
      id: `m${i}`, sender: i % 2 ? "peer" : "me", timestamp: start + i * 60_000, delivery: i % 2 ? undefined : "delivered",
      text: i % 4 === 3 ? `Message ${i}\nwith a second line` : `Message ${i}`,
    }));
    localStorage.setItem(`ghostly_${id}`, JSON.stringify({ id, mySeedB64: mine.seedB64, peerPubKeyB64: mine.peerPubKeyZ32, encKeyB64: mine.encKeyB64, messages, createdAt: start }));
    localStorage.setItem(`ghostly_join_${id}`, "true");
    window.dispatchEvent(new Event("session-updated"));
    location.hash = `/chat/${id}`;
  }, { mine, count });
  await expect(chat(p).locator("[data-message-id]")).toHaveCount(count);
}

/**
 * Sends `text` and returns the list's sizes on every frame, from just before it went until its bubble has settled. The
 * first frame is sampled before the send starts: a busy page can run its first frame after the send has drawn.
 */
async function sendSampled(p: Peer, text: string): Promise<Frame[]> {
  await p.page.evaluate(() => new Promise<void>(sampling => {
    const sampler = { frames: [] as Frame[], stop: false };
    (window as unknown as { sampler: typeof sampler }).sampler = sampler;
    const tick = () => {
      const list = document.querySelector<HTMLElement>("[data-message-list]")!;
      sampler.frames.push({ sw: list.scrollWidth, cw: list.clientWidth, sh: list.scrollHeight, ch: list.clientHeight, top: list.scrollTop, rows: list.querySelectorAll("[data-message-id]").length });
      sampling();
      if (!sampler.stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
  const box = p.page.getByPlaceholder("Message…");
  await box.fill(text);
  await box.press("Enter");
  await expect(chat(p).getByText(text, { exact: true })).toBeVisible();
  await p.page.waitForTimeout(1300);
  return p.page.evaluate(() => {
    const sampler = (window as unknown as { sampler: { frames: Frame[]; stop: boolean } }).sampler;
    sampler.stop = true;
    return sampler.frames;
  });
}

for (const [where, viewport] of [["a narrow window", { width: 900, height: 800 }], ["a phone", undefined]] as const) {
  test(`sending shows no scrollbar, in ${where}`, { tag: ["@feature:chat.scroll"] }, async ({ peer }) => {
    const bob = await peer("send-bob", viewport ? { viewport } : { mobile: true });
    // A short chat: nothing overflows, on any frame.
    await seedChat(bob, 3);
    for (const text of ["Short and sweet", "One more"]) {
      const frames = await sendSampled(bob, text);
      expect(frames.length).toBeGreaterThan(20);
      // The bubble arrived while the frames were sampled, so they saw it come in.
      expect(frames.at(-1)!.rows).toBeGreaterThan(frames[0].rows);
      const overflowing = frames.filter(f => f.sw > f.cw || f.sh > f.ch || f.ch !== frames[0].ch);
      expect(overflowing, `frames where the list overflowed while "${text}" went`).toEqual([]);
    }

    // A long chat at its bottom: never sideways, and the view only goes down, ending at the new message.
    await seedChat(bob, 40);
    const frames = await sendSampled(bob, "At the bottom");
    expect(frames.at(-1)!.rows).toBeGreaterThan(frames[0].rows);
    expect(frames.filter(f => f.sw > f.cw || f.ch !== frames[0].ch), "frames scrolling sideways or losing height").toEqual([]);
    for (let i = 1; i < frames.length; i++) expect(frames[i].top, `scrollTop at frame ${i}`).toBeGreaterThanOrEqual(frames[i - 1].top);
    const last = frames.at(-1)!;
    expect(last.sh - last.top - last.ch).toBeLessThanOrEqual(2);
  });
}

import { createLink } from "@ghostly/core";
import type { Page } from "@playwright/test";
import { chat, expect, test, WAYBACK, type Peer } from "../support/fixtures";

/**
 * A big chat left and opened again, as WhatsApp does it: left at its bottom, it opens at its bottom (with what came
 * meanwhile); left scrolled up, it opens on the message that was at the top of the view, where it was, and nothing is
 * counted. Pictures, videos, voice messages and link previews lay out after the open, and must not move it.
 */

/** A picture 320 × 240, served late: it lays out after the chat has opened. */
const PICTURE = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#7c5cff"/></svg>`;

/** A 1:1 chat of `count` messages straight into this browser's storage: texts, pictures, voice, video, audio, previews. */
function seedChat(page: Page, count: number, label: string): Promise<string> {
  const mine = createLink().mine;
  return page.evaluate(({ mine, count, label }) => {
    // A link preview's thumbnail is a JPEG the sender drew (WISP 401): its box is not known before it decodes.
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const g = canvas.getContext("2d")!;
    g.fillStyle = "#3a7";
    g.fillRect(0, 0, 320, 180);
    const thumb = canvas.toDataURL("image/jpeg", 0.6);
    const peaks = Array.from({ length: 40 }, (_, i) => (i * 37) % 255);
    const id = crypto.randomUUID().replaceAll("-", "");
    const start = Date.now() - 86_400_000;
    const messages = Array.from({ length: count }, (_, i) => {
      const peer = i % 3 !== 0;
      const base = { id: `${peer ? "peer" : "me"}_${label}_${i}`, sender: peer ? "peer" : "me", timestamp: start + i * 60_000, delivery: peer ? undefined : "delivered" };
      if (i === count - 1) return { ...base, text: `${label} last message\nwith a second line\nand a third` };
      if (i % 7 === 3) return { ...base, text: `https://web.archive.org/web/2009/http://geocities.com/${label}${i}.gif` };
      if (i % 11 === 5) return { ...base, text: "", file: { id: `img${label}${i}`, name: `p${i}.jpg`, size: 90_000, mime: "image/jpeg", image: { width: 800, height: 600 } } };
      if (i % 13 === 6) return { ...base, text: "", file: { id: `voice${label}${i}`, name: `v${i}.webm`, size: 20_000, mime: "audio/webm", voice: { duration: 7000, peaks } } };
      if (i % 17 === 8) return { ...base, text: "", file: { id: `video${label}${i}`, name: `m${i}.mp4`, size: 400_000, mime: "video/mp4", video: { duration: 4000, width: 640, height: 360 } } };
      if (i % 19 === 9) return { ...base, text: "", file: { id: `audio${label}${i}`, name: `song${i}.mp3`, size: 300_000, mime: "audio/mpeg" } };
      if (i % 9 === 2) {
        const u = `https://example.com/${label}/${i}`;
        return { ...base, text: `look ${u}`, preview: { u, t: `Page ${i}`, d: "A description long enough to take two lines in the card", s: "Example", i: thumb } };
      }
      return { ...base, text: i % 5 === 0 ? `${label} message ${i}\n${"a longer line of text\n".repeat(4)}end` : `${label} message ${i}` };
    });
    localStorage.setItem(`ghostly_${id}`, JSON.stringify({ id, mySeedB64: mine.seedB64, peerPubKeyB64: mine.peerPubKeyZ32, encKeyB64: mine.encKeyB64, messages, createdAt: start }));
    window.dispatchEvent(new Event("session-updated"));
    return id;
  }, { mine, count, label });
}

/** Messages that arrive while the chat is not open: written where the app keeps them, as its sync does. */
function arrive(page: Page, id: string, texts: string[]): Promise<void> {
  return page.evaluate(({ id, texts }) => {
    const session = JSON.parse(localStorage.getItem(`ghostly_${id}`)!);
    texts.forEach((text, i) => session.messages.push({ id: `peer_away_${Date.now()}_${i}`, sender: "peer", text, timestamp: Date.now() + i }));
    localStorage.setItem(`ghostly_${id}`, JSON.stringify(session));
    window.dispatchEvent(new Event("session-updated"));
  }, { id, texts });
}

const distanceToBottom = (p: Peer) => chat(p).evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight);
const atBottom = (p: Peer) => expect.poll(() => distanceToBottom(p), { timeout: 10_000 }).toBeLessThanOrEqual(2);
const pill = (p: Peer) => p.page.getByTestId("jump-latest");

/** Scrolls up with the mouse wheel, as a hand does. */
async function scrollUp(p: Peer, ticks: number): Promise<void> {
  const box = (await chat(p).boundingBox())!;
  await p.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < ticks; i++) {
    await p.page.mouse.wheel(0, -700);
    await p.page.waitForTimeout(60);
  }
  // The wheel's own smooth scrolling has ended.
  let last = -1;
  await expect.poll(async () => { const top = await chat(p).evaluate(el => el.scrollTop); const still = top === last; last = top; return still; }).toBe(true);
}

/** The first message whose top is in the view, and how far down the view its top is. */
function topRow(p: Peer): Promise<{ id: string; y: number }> {
  return chat(p).evaluate(el => {
    const top = el.getBoundingClientRect().top;
    const row = [...el.querySelectorAll<HTMLElement>("[data-message-id]")].find(row => row.getBoundingClientRect().top >= top + 8)!;
    return { id: row.dataset.messageId!, y: row.getBoundingClientRect().top - top };
  });
}

/** The same message is where it was in the view: now, and after everything around it has had time to load. */
async function backOn(p: Peer, left: { id: string; y: number }): Promise<void> {
  const row = chat(p).locator(`[data-message-id="${left.id}"]`);
  const y = () => row.evaluate(row => row.getBoundingClientRect().top - row.closest(".chat-wallpaper")!.getBoundingClientRect().top);
  await expect.poll(y, { timeout: 10_000 }).toBeGreaterThan(left.y - 3);
  expect(Math.abs(await y() - left.y)).toBeLessThanOrEqual(3);
  await p.page.waitForTimeout(1_500);
  expect(Math.abs(await y() - left.y)).toBeLessThanOrEqual(3);
  expect(await distanceToBottom(p)).toBeGreaterThan(400);
}

test("a big chat opens again at its bottom or on the message it was left on", { tag: ["@feature:chat.scroll"] }, async ({ peer }) => {
  test.setTimeout(3 * 60_000);
  const bob = await peer("restore-bob");
  await bob.context.route(WAYBACK, async route => {
    await new Promise(done => setTimeout(done, 150 + Math.random() * 500));
    await route.fulfill({ status: 200, contentType: "image/svg+xml", body: PICTURE });
  });
  const a = await seedChat(bob.page, 320, "A");
  const b = await seedChat(bob.page, 320, "B");
  const open = (id: string) => bob.page.evaluate(id => { location.hash = `/chat/${id}`; }, id);
  const lastOf = (label: string) => chat(bob).getByText(`${label} last message`, { exact: false });

  await open(a);
  await expect(lastOf("A")).toBeVisible();
  await atBottom(bob);

  // 1. Left at its bottom: opens at its bottom, the last message whole, after the pictures came in.
  await open(b);
  await expect(lastOf("B")).toBeVisible();
  await open(a);
  await expect(lastOf("A")).toBeInViewport({ ratio: 1 });
  await atBottom(bob);
  await bob.page.waitForTimeout(1_500);
  await atBottom(bob);

  // 2. Left scrolled up: opens on the same message, where it was in the view.
  await scrollUp(bob, 14);
  const left = await topRow(bob);
  expect(await distanceToBottom(bob)).toBeGreaterThan(2_000);
  await open(b);
  await expect(lastOf("B")).toBeVisible();
  await open(a);
  await backOn(bob, left);
  await expect(pill(bob)).toHaveAttribute("data-count", "0");

  // 3. Messages that came while away. Scrolled up, it is still on the same message, and nothing is counted: those rows
  // were there when it opened. At its bottom, it opens at the newest of them.
  await open(b);
  await expect(lastOf("B")).toBeVisible();
  await arrive(bob.page, a, ["Away 1", "Away 2"]);
  await open(a);
  await backOn(bob, left);
  await expect(pill(bob)).toHaveAttribute("data-count", "0");
  await pill(bob).click();
  await atBottom(bob);
  await open(b);
  await expect(lastOf("B")).toBeVisible();
  await arrive(bob.page, a, ["Away 3", `Away 4\n${"line\n".repeat(6)}end`]);
  await open(a);
  await expect(chat(bob).getByText("Away 4", { exact: false })).toBeInViewport({ ratio: 1 });
  await atBottom(bob);

  // 4. Quickly back and forth between the two: each is still where it was left (A up, B at its bottom).
  await scrollUp(bob, 10);
  const again = await topRow(bob);
  for (let i = 0; i < 4; i++) {
    await open(b);
    await bob.page.waitForTimeout(80);
    await open(a);
    await bob.page.waitForTimeout(80);
  }
  await backOn(bob, again);
  await open(b);
  await expect(lastOf("B")).toBeInViewport({ ratio: 1 });
  await atBottom(bob);
});

/**
 * Groups: the group page stays mounted from one group to the next. It used to open the next group on the last one's
 * rows, so a group left scrolled up opened at its bottom.
 */
test("a group left scrolled up opens again on that message, from another group too", { tag: ["@feature:chat.scroll"] }, async ({ peer }) => {
  test.setTimeout(4 * 60_000);
  const bob = await peer("restore-groups");
  const page = bob.page;
  const groups: string[] = [];
  for (const name of ["Alpha", "Beta"]) {
    await page.getByTestId("sidebar-new-more").click();
    await page.getByTestId("new-group").click();
    await page.getByTestId("new-group-name").fill(name);
    await page.getByTestId("new-group-create").click();
    await page.getByTestId("group-share-dialog").getByTestId("group-share-done").click();
    await expect(page).toHaveURL(/#\/group\//);
    groups.push(page.url().split("/group/")[1]);
    const box = page.getByPlaceholder("Message…");
    for (let i = 0; i < 40; i++) {
      await box.fill(`${name} ${i}\n${"line\n".repeat(i % 4)}end`);
      await box.press("Enter");
      await expect(chat(bob).getByText(`${name} ${i}`, { exact: false })).toBeVisible();
    }
  }
  const [alpha, beta] = groups;
  const open = (id: string) => page.evaluate(id => { location.hash = `/group/${id}`; }, id);
  const last = (name: string) => chat(bob).getByText(`${name} 39`, { exact: false });
  const direct = await seedChat(page, 60, "C");

  await open(alpha);
  await expect(last("Alpha")).toBeVisible();
  await atBottom(bob);
  await scrollUp(bob, 3);
  const left = await topRow(bob);
  expect(await distanceToBottom(bob)).toBeGreaterThan(1_000);

  // Straight to the other group and back.
  await open(beta);
  await expect(last("Beta")).toBeInViewport({ ratio: 1 });
  await atBottom(bob);
  await open(alpha);
  await backOn(bob, left);

  // By way of a 1:1 chat.
  await open(direct);
  await expect(chat(bob).getByText("C last message", { exact: false })).toBeVisible();
  await open(alpha);
  await backOn(bob, left);

  // Quickly back and forth: Alpha still up, Beta still at its bottom.
  for (let i = 0; i < 4; i++) {
    await open(beta);
    await page.waitForTimeout(60);
    await open(alpha);
    await page.waitForTimeout(60);
  }
  await backOn(bob, left);
  await open(beta);
  await expect(last("Beta")).toBeInViewport({ ratio: 1 });
  await atBottom(bob);
});

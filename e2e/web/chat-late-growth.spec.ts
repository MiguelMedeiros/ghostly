import { createLink } from "@ghostly/core";
import type { Page } from "@playwright/test";
import { chat, expect, test, WAYBACK, type Peer } from "../support/fixtures";

/**
 * A long chat like the one with a bot: markdown with bold and lists, emoji, links to a local server and to GitHub with
 * preview cards, voice notes, edited status messages with reactions, pictures by link that load late, and a draft of
 * several lines in the composer. Opened again, it stays on its last message while all of that lays out; typing in the
 * composer (which measures its text at another height for an instant) does not leave it short of the last message.
 */

/** A picture 320 × 240, served late: it lays out after the chat has opened. */
const PICTURE = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#7c5cff"/></svg>`;

function seedBotChat(page: Page, count: number, label: string, draft?: string): Promise<string> {
  const mine = createLink().mine;
  return page.evaluate(({ mine, count, label, draft }) => {
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
      const peer = i % 4 !== 0;
      const at = start + i * 60_000;
      const base = { id: `${peer ? "peer" : "me"}_${label}_${i}`, sender: peer ? "peer" : "me", timestamp: at, delivery: peer ? undefined : "delivered" };
      if (i === count - 1) return { ...base, text: `🤖 **${label} last message**\n- first point\n- second point\nhttp://127.0.0.1:4340/status/${i}` };
      if (i % 11 === 3) return { ...base, text: "", file: { id: `voice${label}${i}`, name: `v${i}.webm`, size: 20_000, mime: "audio/webm", voice: { duration: 7000, peaks } } };
      if (i % 7 === 2) return { ...base, text: `https://web.archive.org/web/2009/http://geocities.com/${label}${i}.gif` };
      if (i % 9 === 4) {
        const u = `https://github.com/MiguelMedeiros/ghostly/pull/${400 + i}`;
        return { ...base, text: `✅ **PR opened** ${u}`, preview: { u, t: `fix: thing ${i}`, d: "A description long enough to take two lines in the card", s: "GitHub", i: thumb } };
      }
      if (i % 6 === 1) {
        return { ...base, text: `📌 **Status ${i}**\n- **CI** green\n- merged into dev\n- http://127.0.0.1:4340/chat/${i}`,
          edit: { seq: 2, at: at + 5_000, history: [{ at, text: "working…" }] },
          reactions: i % 12 === 1 ? { me: { e: "👍", n: 1, at: at + 9_000 } } : undefined };
      }
      return { ...base, text: i % 5 === 0 ? `${label} message ${i} 🎉\n${"a longer line of **bold** text\n".repeat(3)}end` : `${label} message ${i} 👻` };
    });
    localStorage.setItem(`ghostly_${id}`, JSON.stringify({ id, mySeedB64: mine.seedB64, peerPubKeyB64: mine.peerPubKeyZ32, encKeyB64: mine.encKeyB64, messages, createdAt: start }));
    if (draft) localStorage.setItem(`ghostly_draft_${id}`, draft);
    window.dispatchEvent(new Event("session-updated"));
    return id;
  }, { mine, count, label, draft });
}

const distanceToBottom = (p: Peer) => chat(p).evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight);
/** At the bottom within a moment: nothing a hand would have to scroll. */
const atBottom = (p: Peer) => expect.poll(() => distanceToBottom(p), { timeout: 3_000 }).toBeLessThanOrEqual(2);

test("a long bot chat stays on its last message while it lays out and while I type", { tag: ["@feature:chat.scroll"] }, async ({ peer }) => {
  test.setTimeout(3 * 60_000);
  const bob = await peer("late-bob");
  await bob.context.route(WAYBACK, async route => {
    await new Promise(done => setTimeout(done, 150 + Math.random() * 700));
    await route.fulfill({ status: 200, contentType: "image/svg+xml", body: PICTURE });
  });
  const a = await seedBotChat(bob.page, 400, "A", "a draft\nof four\nlines to\nsend later");
  const b = await seedBotChat(bob.page, 30, "B");
  const open = (id: string) => bob.page.evaluate(id => { location.hash = `/chat/${id}`; }, id);
  const last = chat(bob).getByText("A last message", { exact: false });

  for (let round = 0; round < 2; round++) {
    await open(b);
    await expect(chat(bob).getByText("B last message", { exact: false })).toBeVisible();
    await open(a);
    await expect(last).toBeVisible();
    // Everything near the bottom has come in and laid out (the older rows, the pictures), and it is still at the end.
    await expect.poll(() => chat(bob).locator("img").evaluateAll(imgs =>
      imgs.filter(img => img.getBoundingClientRect().bottom > 0 && !(img as HTMLImageElement).complete).length)).toBe(0);
    await bob.page.waitForTimeout(1_000);
    expect(await distanceToBottom(bob)).toBeLessThanOrEqual(2);
    await expect(last).toBeInViewport({ ratio: 1 });
  }

  // The draft came back in the composer, several lines tall. Each key makes it measure its text at one line for an
  // instant, and the browser pulls the list's view up by the difference: it must come back to the last message.
  const box = bob.page.getByPlaceholder("Message…");
  await expect(box).toHaveValue("a draft\nof four\nlines to\nsend later");
  await box.click();
  await box.press("End");
  await box.pressSequentially("!");
  await atBottom(bob);
  for (let i = 0; i < 3; i++) await box.press("Shift+Enter");
  await box.pressSequentially("more");
  await atBottom(bob);
  await expect(last).toBeInViewport({ ratio: 1 });

  // A hand that scrolls up a little is left where it put the view.
  const view = (await chat(bob).boundingBox())!;
  await bob.page.mouse.move(view.x + view.width / 2, view.y + view.height / 2);
  await bob.page.mouse.wheel(0, -60);
  await expect.poll(() => distanceToBottom(bob)).toBeGreaterThan(30);
  await bob.page.waitForTimeout(1_500);
  expect(await distanceToBottom(bob)).toBeGreaterThan(30);
});

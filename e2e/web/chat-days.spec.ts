import { createLink } from "@ghostly/core";
import { chat, expect, test, type Peer } from "../support/fixtures";

/**
 * A chat's messages under the date of their day (public request ghostly#3781): a date above each day's first message,
 * and the date of the day being read stuck at the top of the list while it scrolls, until the next day's pushes it
 * out. The stuck date takes no clicks, and scrolling under it moves nothing.
 */

/** Rows a day: each a few lines tall, so one day is taller than the view. */
const PER_DAY = 14;

/** A chat whose history is two days ago, yesterday and today, in this browser's own time zone. */
async function seedDays(p: Peer) {
  const keys = createLink().mine;
  await p.page.evaluate(({ keys, perDay }) => {
    const midnight = new Date().setHours(0, 0, 0, 0);
    const messages = [2, 1, 0].flatMap(back => {
      const day = new Date(midnight);
      day.setDate(day.getDate() - back);
      return Array.from({ length: perDay }, (_, i) => {
        const n = (2 - back) * perDay + i, mine = n % 3 === 0, ref = `d${String(n).padStart(4, "0")}ab`;
        // Today's from midnight: none of them later than now, whenever the run is.
        return { id: `${mine ? "me" : "peer"}_${ref}`, ref, sender: mine ? "me" : "peer", timestamp: day.getTime() + i * 60_000,
          text: `Day ${2 - back} row ${i}\nsecond line\nthird line`, ...(mine && { delivery: "delivered" }) };
      });
    });
    const id = crypto.randomUUID().replaceAll("-", "");
    localStorage.setItem(`ghostly_${id}`, JSON.stringify({
      id, profile: "paired-chat/1", mySeedB64: keys.seedB64, peerPubKeyB64: keys.peerPubKeyZ32, encKeyB64: keys.encKeyB64,
      label: "Three days", messages, createdAt: messages[0].timestamp,
    }));
    window.dispatchEvent(new Event("session-updated"));
  }, { keys, perDay: PER_DAY });
}

/** Where each date is, from the top of the list's view. */
const dates = (p: Peer) => chat(p).evaluate(list => {
  const top = list.getBoundingClientRect().top;
  return [...list.querySelectorAll<HTMLElement>("[data-testid=chat-day]")].map(el => {
    const box = el.querySelector("time")!.getBoundingClientRect();
    return { text: el.textContent, top: box.top - top, bottom: box.bottom - top };
  });
});

test("each day has its date, and the date of the day being read stays at the top while it scrolls", { tag: ["@feature:chat.days", "@feature:chat.scroll"] }, async ({ peer }, testInfo) => {
  const bob = await peer("days-bob");
  await seedDays(bob);
  await bob.page.reload();
  await bob.page.getByTestId("chat-row-name").filter({ hasText: "Three days" }).click();
  await expect(chat(bob).getByText("Day 2 row 13", { exact: false })).toBeInViewport();

  // One date a day, in order: the oldest by its weekday and date, in this browser's language and zone.
  const oldest = await bob.page.evaluate(() => {
    const day = new Date();
    day.setDate(day.getDate() - 2);
    return new Intl.DateTimeFormat("en", { weekday: "long", day: "numeric", month: "long" }).format(day);
  });
  await expect(chat(bob).getByTestId("chat-day")).toHaveText([oldest, "Yesterday", "Today"]);

  // In the middle of yesterday: its date is stuck at the top of the view, today's is down in the list.
  const row = (day: number, i: number) => chat(bob).getByText(`Day ${day} row ${i}`, { exact: false });
  await row(1, 7).evaluate(el => el.scrollIntoView({ block: "center" }));
  await expect.poll(async () => (await dates(bob))[1].top).toBeCloseTo(8, 0);
  const [first, yesterday, today] = await dates(bob);
  expect(first.bottom).toBeLessThanOrEqual(0);
  expect(today.top).toBeGreaterThan(yesterday.bottom + 100);
  await bob.page.screenshot({ path: testInfo.outputPath("day-stuck.png") });

  // The stuck date takes no click: what is under it gets it.
  const under = await chat(bob).evaluate(list => {
    const time = list.querySelectorAll("[data-testid=chat-day]")[1].querySelector("time")!.getBoundingClientRect();
    return document.elementFromPoint(time.left + time.width / 2, time.top + time.height / 2)?.closest("[data-testid=chat-day]") ?? null;
  });
  expect(under).toBeNull();

  // At the day's end, today's date pushes yesterday's out: never one over the other.
  await chat(bob).evaluate(list => {
    const today = list.querySelectorAll("section[data-day]")[2] as HTMLElement;
    list.scrollTop += today.getBoundingClientRect().top - list.getBoundingClientRect().top - 12;
  });
  await expect.poll(async () => (await dates(bob))[1].bottom).toBeLessThan(12);
  const [, pushed, next] = await dates(bob);
  expect(pushed.bottom).toBeLessThanOrEqual(next.top + 0.5);
  await bob.page.screenshot({ path: testInfo.outputPath("day-handover.png") });

  // Scrolled into today, its date is the one at the top, and the view stays where it was put.
  await row(2, 6).evaluate(el => el.scrollIntoView({ block: "center" }));
  await expect.poll(async () => (await dates(bob))[2].top).toBeCloseTo(8, 0);
  const at = await chat(bob).evaluate(list => list.scrollTop);
  await bob.page.waitForTimeout(500);
  expect(await chat(bob).evaluate(list => list.scrollTop)).toBe(at);
});

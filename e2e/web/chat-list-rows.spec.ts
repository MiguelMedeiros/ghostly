import type { Locator, Page } from "@playwright/test";
import { expect, say, test } from "../support/fixtures";
import { pair } from "../support/paired";

/**
 * The chat list's rows, as a messenger draws them: two lines (name and time; the last message with its
 * delivery mark, and the unread count), the contact's key out of the row but in its tooltip. Checked at the
 * list's narrowest (280px), wide, and on a phone; and the Comfortable density that brings the key line back.
 */

const rows = (page: Page) => page.getByTestId("sidebar").getByTestId("chat-row");
const box = async (locator: Locator) => (await locator.boundingBox())!;

/** Drags the list's edge to `width` (the handle clamps it to 280–600). */
async function sidebarWidth(page: Page, width: number): Promise<void> {
  const handle = await box(page.getByTestId("sidebar-resize"));
  await page.mouse.move(handle.x + 1, handle.y + 300);
  await page.mouse.down();
  await page.mouse.move(width, handle.y + 300, { steps: 4 });
  await page.mouse.up();
}

/** Nothing in a row sticks out of it, and no text in it wraps. */
async function rowProblems(row: Locator): Promise<string[]> {
  return row.evaluate((el) => {
    const edge = el.getBoundingClientRect();
    const problems: string[] = [];
    // A line cut short with an ellipsis clips what is inside it: only the line itself must fit.
    const clipped = (child: Element) => { for (let p = child.parentElement; p && p !== el; p = p.parentElement) if (getComputedStyle(p).overflowX !== "visible") return true; return false; };
    for (const child of el.querySelectorAll<HTMLElement>("*")) {
      const r = child.getBoundingClientRect();
      const s = getComputedStyle(child);
      if (!r.width || s.visibility === "hidden" || s.position === "absolute" && s.opacity === "0") continue;
      if (child.classList.contains("sr-only") || clipped(child)) continue;
      if (r.right > edge.right + 1 || r.left < edge.left - 1) problems.push(`${child.tagName} "${child.textContent?.slice(0, 30)}" sticks out`);
    }
    for (const line of el.querySelectorAll<HTMLElement>("[data-testid=chat-row-name], p")) {
      if (line.getBoundingClientRect().height > 24) problems.push(`"${line.textContent?.slice(0, 30)}" wraps`);
    }
    return problems;
  });
}

test("a chat's row is two lines, the key in its tooltip, and the pin and delete buttons move nothing", { tag: ["@feature:chats.list.rows", "@feature:chats.list.pin"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob", { viewport: { width: 1100, height: 800 } })]);
  await pair(alice, bob);
  // Bob is elsewhere when it arrives: the list counts it.
  await bob.page.goto("/#/settings");
  await say(alice, "A message long enough to be cut short at the end of the row, however wide the list is");
  const row = rows(bob.page).first();
  await expect(row.getByTestId("chat-row-unread")).toHaveText("1", { timeout: 15_000 });
  await expect(row).toContainText("A message long enough");
  // Alice's own last message carries its delivery mark.
  await expect(rows(alice.page).first().getByTestId("chat-row-delivery")).toBeVisible();

  // The key is not a line of its own; it is in the row's tooltip.
  const key = await bob.page.evaluate(() => Object.values(localStorage).map((v) => { try { return JSON.parse(v); } catch { return null; } })
    .find((s) => s && Array.isArray(s.messages))?.peerPubKeyB64 as string);
  const short = `${key.slice(0, 6)}...${key.slice(-6)}`;
  await expect(row.getByTestId("chat-row-key")).toHaveCount(0);
  await expect(row).toHaveAttribute("title", new RegExp(`· ${short.replaceAll(".", "\\.")}$`));
  await expect(row.getByText(short, { exact: false })).toHaveClass(/sr-only/);

  for (const width of [280, 600]) {
    await sidebarWidth(bob.page, width);
    const r = await box(row);
    expect(r.height, `row height at ${width}px`).toBeGreaterThanOrEqual(60);
    expect(r.height, `row height at ${width}px`).toBeLessThanOrEqual(70);
    expect(await rowProblems(row), `row at ${width}px`).toEqual([]);

    // Hovering shows the actions over the time: the name and the message stay where they were.
    await bob.page.mouse.move(900, 700);
    const name = await box(row.getByTestId("chat-row-name"));
    const preview = await box(row.locator("p"));
    await row.hover();
    const actions = row.getByTestId("chat-row-actions");
    await expect(actions).toHaveCSS("opacity", "1");
    expect(await box(row.getByTestId("chat-row-name"))).toEqual(name);
    expect(await box(row.locator("p"))).toEqual(preview);
    expect((await box(row)).height).toBe(r.height);
    const time = await box(row.getByTestId("chat-row-time"));
    const cover = await box(actions);
    expect(cover.x + cover.width).toBeGreaterThanOrEqual(time.x + time.width - 1);
  }

  // Pinning from the row: the pin stays beside the count, the row keeps its height.
  const height = (await box(row)).height;
  await row.getByRole("button", { name: "Pin chat", exact: true }).click();
  await bob.page.mouse.move(900, 700);
  const unpin = row.getByRole("button", { name: "Unpin chat", exact: true });
  await expect(unpin).toHaveCSS("opacity", "1");
  expect((await box(row)).height).toBe(height);
  await expect(bob.page).toHaveURL(/#\/settings$/);
});

test("on a phone the whole row is the target, at least 40px tall, with nothing cut off", { tag: ["@feature:chats.list.rows"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob", { mobile: true })]);
  await pair(alice, bob);
  await say(alice, "Hello from a wide screen to a narrow one, cut to fit");
  await bob.page.goto("/#/");
  const row = rows(bob.page).first();
  await expect(row).toContainText("Hello from a wide screen", { timeout: 15_000 });
  const r = await box(row);
  expect(r.height).toBeGreaterThanOrEqual(40);
  expect(r.height).toBeLessThanOrEqual(70);
  expect(r.width).toBeGreaterThan(360);
  expect(await rowProblems(row)).toEqual([]);
  // No hover on a phone: the actions stay out of the way.
  await expect(row.getByTestId("chat-row-actions")).toBeHidden();
  await row.tap();
  await expect(bob.page.getByPlaceholder("Message…")).toBeVisible();
});

test("Comfortable brings the key back as a line of its own, and the choice survives a reload", { tag: ["@feature:settings.chat-list-density"] }, async ({ peer }) => {
  const { page } = await peer("density");
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  const row = rows(page).first();
  await expect(row).toBeVisible();
  await expect(row.getByTestId("chat-row-key")).toHaveCount(0);
  const compact = (await box(row)).height;

  await page.goto("/#/settings");
  const choice = page.getByTestId("chat-list-density");
  await expect(choice.getByRole("button", { name: "Compact" })).toHaveAttribute("aria-pressed", "true");
  await choice.getByRole("button", { name: "Comfortable" }).click();
  await expect(row.getByTestId("chat-row-key")).toBeVisible();
  expect((await box(row)).height).toBeGreaterThan(compact);

  await page.reload();
  await expect(rows(page).first().getByTestId("chat-row-key")).toBeVisible();
  await page.getByTestId("chat-list-density").getByRole("button", { name: "Compact" }).click();
  await expect(rows(page).first().getByTestId("chat-row-key")).toHaveCount(0);
});

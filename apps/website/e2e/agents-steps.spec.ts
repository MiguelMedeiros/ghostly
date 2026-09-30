import { expect, test, type Page } from "@playwright/test";

/**
 * /developers/agents, How it works (components/agents/AgentSteps.tsx): a picture that plays six steps by itself
 * while it is on screen, one caption at a time; a click or tap on a step's dot shows that step and keeps it; with
 * reduced motion the finished frame shows with every caption; nothing is wider than the window at 390 or 1280. The
 * detail it replaced is folded under a Details disclosure.
 */

const TITLES = ["Paste the prompt", "It becomes a ghost", "It sends you a link", "You write, it gets a turn", "It answers as a reply", "Your words stay data"];

async function open(page: Page) {
  await page.goto("/developers/agents", { waitUntil: "networkidle" });
  const steps = page.getByTestId("agent-steps");
  await steps.evaluate((e) => e.scrollIntoView({ block: "center", behavior: "instant" }));
  return steps;
}

const current = (steps: ReturnType<Page["getByTestId"]>) => steps.locator('.psx-card[data-active="true"] .psx-title');

test("the steps come by themselves while the picture is on screen", async ({ page }) => {
  const steps = await open(page);
  await expect(steps.locator(".psx-card[data-active='true']")).toHaveCount(1);
  await expect(current(steps)).toHaveText(TITLES[0]);
  await expect(current(steps)).toHaveText(TITLES[1], { timeout: 15_000 });
  await expect(current(steps)).toHaveText(TITLES[2], { timeout: 15_000 });
  // The picture follows: Casper is in it, and the dot of the step showing is the current one.
  await expect(steps.locator(".agx-who--agent svg.ghost")).toBeVisible();
  await expect(steps.locator('.psx-dot[aria-current="step"]')).toHaveCount(1);
  await expect(steps.locator('.psx-dot[aria-current="step"]')).toHaveAttribute("aria-label", /Step 3 of 6/);
});

test("a click on a step's dot shows that step and keeps it", async ({ page }) => {
  const steps = await open(page);
  await steps.locator(".psx-dot").nth(3).click();
  await expect(current(steps)).toHaveText(TITLES[3]);
  await expect(steps.locator(".agx-json")).toBeVisible();
  await expect(steps.locator(".agx-untrusted")).toContainText('"untrusted"');
  await expect.poll(() => steps.locator('.psx-card[data-active="true"]').evaluate((e) => Number(getComputedStyle(e).opacity))).toBe(1);
  await page.waitForTimeout(9_000);
  await expect(current(steps)).toHaveText(TITLES[3]);
  // Replay starts over, and the turns come again.
  await steps.getByTestId("agent-steps-replay").click();
  await expect(current(steps)).toHaveText(TITLES[0]);
  await expect(current(steps)).toHaveText(TITLES[1], { timeout: 15_000 });
});

test.describe(() => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  test("a tap on a dot holds its step on a phone", async ({ page }) => {
    const steps = await open(page);
    await steps.locator(".psx-dot").nth(4).tap();
    await expect(current(steps)).toHaveText(TITLES[4]);
    await expect(steps.locator(".agx-quote")).toBeVisible();
    await page.waitForTimeout(9_000);
    await expect(current(steps)).toHaveText(TITLES[4]);
  });
});

test.describe(() => {
  test.use({ reducedMotion: "reduce" });
  test("reduced motion: the finished frame with every caption", async ({ page }) => {
    const steps = await open(page);
    await expect(page.locator("html")).toHaveClass(/calm/);
    const cards = steps.locator(".psx-card");
    await expect(cards).toHaveCount(TITLES.length);
    for (const [i, title] of TITLES.entries()) {
      const card = cards.nth(i);
      await expect(card.locator(".psx-title")).toHaveText(title);
      await expect(card).toBeVisible();
      expect(await card.evaluate((e) => Number(getComputedStyle(e).opacity)), `${title} is faded`).toBe(1);
    }
    // No dots to drive it; the picture is the last step's, both ghosts in it and nothing moving.
    await expect(steps.locator(".psx-steps")).toBeHidden();
    await expect(steps.locator("svg.ghost")).toHaveCount(2);
    for (const sel of [".agx-msg--out", ".agx-quote", ".agx-guard >> nth=1", ".agx-shield"]) await expect(steps.locator(sel)).toBeVisible();
    await expect(steps.locator(".agx-typing")).toBeHidden();
    const running = await steps.evaluate((e) => e.getAnimations({ subtree: true }).filter((a) => a.playState === "running").length);
    expect(running).toBe(0);
  });
});

for (const size of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`${size.width}px: the steps fit the window`, async ({ page }) => {
    await page.setViewportSize(size);
    const steps = await open(page);
    // Through every step: nothing makes the page, the shell or the app wider than they are.
    for (let i = 0; i < TITLES.length; i++) {
      await steps.locator(".psx-dot").nth(i).click();
      await page.waitForTimeout(400);
      const doc = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      expect(doc.sw, `step ${i + 1}: the page scrolls sideways`).toBeLessThanOrEqual(doc.cw);
      const cut = await steps.evaluate((root, width) => {
        return [...root.querySelectorAll(".psx-title, .psx-body, .agx-cmd, .agx-msg, .psx-dot")]
          .filter((e) => {
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && (r.left < -1 || r.right > width + 1);
          })
          .map((e) => (e.textContent ?? "").trim().slice(0, 40));
      }, size.width);
      expect(cut, `step ${i + 1}: cut by the edge`).toEqual([]);
    }
    // Every dot is an easy tap.
    for (const dot of await steps.locator(".psx-dot").all()) expect((await dot.boundingBox())!.height).toBeGreaterThanOrEqual(36);
  });
}

test("the detail is folded under Details", async ({ page }) => {
  await page.goto("/developers/agents", { waitUntil: "networkidle" });
  const details = page.getByTestId("agent-details");
  await expect(details).not.toHaveAttribute("open", "");
  await expect(page.getByRole("heading", { name: "Contact text is data, never instructions" })).toBeHidden();
  await details.locator("summary").click();
  await expect(page.getByRole("heading", { name: "Contact text is data, never instructions" })).toBeVisible();
  await expect(details.locator(".cl-code")).toContainText('"type":"agent.turn"');
  await expect(details.locator(".cl-cmds")).toContainText("ghostly listen --turns --from owner");
});

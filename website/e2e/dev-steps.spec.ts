import { expect, test, type Page } from "@playwright/test";

/**
 * The Developers opening: the protocol explainer (components/dev/ProtocolSteps.tsx).
 *
 * - Next, Previous, the dots and the keys move between the eight steps; going
 *   back plays the step being left in reverse (the picture's `--t` goes down,
 *   not jumps).
 * - Every step, in English and Portuguese, has its title, what goes on the wire
 *   and links to the WISPs it cites.
 * - Reduced motion: each step is its finished frame at once, nothing runs.
 * - At desktop, upright (the Claude app's browser panel) and phone sizes the
 *   stage shown is the right one, nothing in it overlaps or leaves it, its text
 *   renders at 12px or more, and the page does not scroll sideways.
 */

const STEP_IDS = [
  "publish",
  "invite",
  "contact",
  "offers",
  "transport",
  "proof",
  "frames",
  "floor",
];
/** The last moment of each step on the timeline (protocolTimeline.ts END). */
const END = [2.6, 5, 8.6, 11.4, 14.4, 18.2, 22.6, 26.8];

const current = (page: Page) => page.locator('.psx-card[data-state="current"]');
const tValue = (page: Page) =>
  page
    .locator(".psx")
    .evaluate((el) => Number(getComputedStyle(el).getPropertyValue("--t")));

async function open(page: Page, path = "/developers") {
  await page.goto(path, { waitUntil: "networkidle" });
  const root = page.locator(".psx");
  await root.scrollIntoViewIfNeeded();
  return root;
}

test("next, previous, the dots and the keys move between steps", async ({
  page,
}) => {
  const root = await open(page);
  // The first step plays by itself once in view, and stops on its finished frame.
  await expect.poll(() => tValue(page), { timeout: 8000 }).toBe(END[0]);
  await expect(current(page)).toHaveAttribute("data-step-id", "publish");
  await expect(root.locator('[data-action="prev"]')).toHaveAttribute("aria-disabled", "true");

  await root.locator('[data-action="next"]').click();
  await expect(current(page)).toHaveAttribute("data-step-id", "invite");
  await expect(page.getByTestId("psx-announce")).toHaveText(
    "Step 2 of 8: One code carries the keys",
  );
  await expect(root.locator('.psx-dot[aria-current="step"]')).toHaveAttribute(
    "aria-label",
    "Step 2 of 8: Invite",
  );
  await expect.poll(() => tValue(page), { timeout: 8000 }).toBe(END[1]);

  // Keys, with focus in the explainer.
  await page.keyboard.press("ArrowRight");
  await expect(current(page)).toHaveAttribute("data-step-id", "contact");
  await expect.poll(() => tValue(page), { timeout: 8000 }).toBe(END[2]);

  // Back plays step 3 in reverse, down to step 2's finished frame.
  await page.keyboard.press("ArrowLeft");
  await expect(current(page)).toHaveAttribute("data-step-id", "invite");
  const seen: number[] = [];
  for (let i = 0; i < 6; i++) {
    seen.push(await tValue(page));
    await page.waitForTimeout(120);
  }
  expect(
    seen.some((t) => t > END[1] && t < END[2]),
    `reverse passes through step 3: ${seen}`,
  ).toBe(true);
  for (let i = 1; i < seen.length; i++)
    expect(seen[i]).toBeLessThanOrEqual(seen[i - 1]);
  await expect.poll(() => tValue(page), { timeout: 8000 }).toBe(END[1]);

  await root.locator('[data-action="prev"]').click();
  await expect(current(page)).toHaveAttribute("data-step-id", "publish");

  // End and Home, and a dot: a jump plays the target from its start.
  await page.keyboard.press("End");
  await expect(current(page)).toHaveAttribute("data-step-id", "floor");
  await expect(root.locator('[data-action="next"]')).toHaveAttribute("aria-disabled", "true");
  await expect.poll(() => tValue(page), { timeout: 10_000 }).toBe(END[7]);
  await page.keyboard.press("Home");
  await expect(current(page)).toHaveAttribute("data-step-id", "publish");
  await root.locator(".psx-dot").nth(4).click();
  await expect(current(page)).toHaveAttribute("data-step-id", "transport");
  await expect.poll(() => tValue(page), { timeout: 8000 }).toBe(END[4]);

  // Replay rewinds the step and plays it again.
  await root.locator('[data-action="replay"]').click();
  await expect
    .poll(() => tValue(page), { timeout: 4000 })
    .toBeLessThan(END[4] - 0.5);
  await expect.poll(() => tValue(page), { timeout: 8000 }).toBe(END[4]);

  // With nothing focused, the arrows still step while the explainer is in view.
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
  await page.keyboard.press("ArrowRight");
  await expect(current(page)).toHaveAttribute("data-step-id", "proof");
});

test("play all goes through the steps and stops at the end", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const root = await open(page);
  await root.locator(".psx-dot").nth(5).click();
  const all = root.locator('[data-action="all"]');
  await all.click();
  await expect(all).toHaveAttribute("aria-pressed", "true");
  await expect(current(page)).toHaveAttribute("data-step-id", "frames", {
    timeout: 15_000,
  });
  await expect(current(page)).toHaveAttribute("data-step-id", "floor", {
    timeout: 15_000,
  });
  await expect(all).toHaveAttribute("aria-pressed", "false", {
    timeout: 15_000,
  });
  await expect.poll(() => tValue(page)).toBe(END[7]);
  // Nothing advances by itself afterwards.
  await page.waitForTimeout(1500);
  await expect(current(page)).toHaveAttribute("data-step-id", "floor");
});

for (const [path, sample] of [
  [
    "/developers",
    {
      title: "Rank the transports",
      wire: "3 + 1 = 4, direct: goes first",
      wisp: "/developers/wisps/100-transports",
    },
  ],
  [
    "/pt-br/developers",
    {
      title: "Ordenar os transportes",
      wire: "3 + 1 = 4, direto: vai primeiro",
      wisp: "/pt-br/developers/wisps/100-transports",
    },
  ],
] as const) {
  test.describe(() => {
    test.use({ reducedMotion: "reduce" });
    test(`every step has its content and WISP links on ${path}`, async ({
      page,
    }) => {
      const root = await open(page, path);
      for (let i = 0; i < STEP_IDS.length; i++) {
        const card = current(page);
        await expect(card).toHaveAttribute("data-step-id", STEP_IDS[i]);
        await expect(card.locator(".psx-title")).not.toBeEmpty();
        await expect(card.locator(".psx-body")).not.toBeEmpty();
        expect(
          await card.locator(".psx-wire dt").count(),
        ).toBeGreaterThanOrEqual(3);
        const links = card.locator(".psx-wisp");
        expect(await links.count()).toBeGreaterThanOrEqual(1);
        for (const href of await links.evaluateAll((els) =>
          els.map((e) => e.getAttribute("href") ?? ""),
        )) {
          expect(href).toMatch(
            path.startsWith("/pt-br")
              ? /^\/pt-br\/developers\/wisps\/[\w-]+$/
              : /^\/developers\/wisps\/[\w-]+$/,
          );
        }
        if (STEP_IDS[i] === "transport") {
          await expect(card.locator(".psx-title")).toHaveText(sample.title);
          await expect(card.locator(".psx-wire")).toContainText(sample.wire);
          await expect(card.locator(`a[href="${sample.wisp}"]`)).toHaveText(
            "WISP 100",
          );
        }
        if (i < STEP_IDS.length - 1)
          await root.locator('[data-action="next"]').click();
      }
      // A WISP link opens its rendered page.
      const res = await page.request.get(sample.wisp);
      expect(res.status()).toBe(200);
    });
  });
}

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("each step is its finished frame at once, and nothing runs", async ({
    page,
  }) => {
    const root = await open(page);
    await expect(page.locator("html")).toHaveClass(/calm/);
    expect(await tValue(page)).toBe(END[0]);
    await expect(root.locator('[data-action="replay"]')).toBeHidden();
    for (let i = 1; i < STEP_IDS.length; i++) {
      await root.locator('[data-action="next"]').click();
      // Instant: the finished frame right after the click, not after an animation.
      expect(await tValue(page)).toBe(END[i]);
      await expect(current(page)).toHaveAttribute("data-step-id", STEP_IDS[i]);
    }
    await root.locator('[data-action="prev"]').click();
    expect(await tValue(page)).toBe(END[6]);
    const running = await page.evaluate(
      () =>
        document
          .getAnimations()
          .filter(
            (a) =>
              a.playState === "running" &&
              (a.effect as KeyframeEffect | null)?.target?.closest?.(".psx"),
          ).length,
    );
    expect(running).toBe(0);
  });
});

/** Viewports Miguel reviews at: desktop, the Claude app's upright browser panel, a tablet and phones. */
const VIEWPORTS = [
  { name: "desktop 1440x900", width: 1440, height: 900, stage: "land" },
  { name: "desktop 1280x800", width: 1280, height: 800, stage: "land" },
  { name: "upright 1009x1239", width: 1009, height: 1239, stage: "land" },
  { name: "tablet 768x1024", width: 768, height: 1024, stage: "land" },
  { name: "phone 390x844", width: 390, height: 844, stage: "port" },
  { name: "phone 360x740", width: 360, height: 740, stage: "port" },
] as const;

for (const vp of VIEWPORTS) {
  test.describe(() => {
    test.use({
      viewport: { width: vp.width, height: vp.height },
      reducedMotion: "reduce",
    });
    test(`nothing overlaps or leaves the stage at ${vp.name}`, async ({
      page,
    }) => {
      const root = await open(page);
      const svg = root.locator(`svg.psx-svg--${vp.stage}`);
      await expect(svg).toBeVisible();
      await expect(
        root.locator(`svg.psx-svg--${vp.stage === "land" ? "port" : "land"}`),
      ).toBeHidden();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
      ).toBe(true);

      for (let i = 0; i < STEP_IDS.length; i++) {
        const report = await svg.evaluate((s: SVGSVGElement) => {
          const box = s.getBoundingClientRect();
          const scale = box.width / s.viewBox.baseVal.width;
          const seen = (el: Element) => {
            let o = 1;
            for (let e: Element | null = el; e && e !== s; e = e.parentElement)
              o *= Number(getComputedStyle(e).opacity);
            return o > 0.2;
          };
          // What must stay readable: tags, chips, names, the layer label, captions, the thumbs-up, ghost bodies, records.
          const items: { what: string; r: DOMRect }[] = [];
          const add = (
            sel: string,
            what: (el: Element) => string,
            pick: (el: Element) => Element = (el) => el,
          ) =>
            s.querySelectorAll(sel).forEach((el) => {
              if (!seen(el)) return;
              const r = pick(el).getBoundingClientRect();
              if (r.width > 1 && r.height > 1)
                items.push({ what: what(el), r });
            });
          add(
            ".sx-tag",
            (el) => `tag "${el.textContent}"`,
            (el) => el.querySelector("rect") ?? el,
          );
          add(
            ".sx-chip",
            (el) => `chip "${el.textContent}"`,
            (el) => el.querySelector("rect") ?? el,
          );
          add(
            ".sx-name, .sx-label, .sx-oob-tag",
            (el) => `text "${el.textContent}"`,
          );
          add(".sx-thumbs", () => "thumbs-up");
          add(".sx-record", () => "record");
          add(".sx-trio", () => "frame on the line");
          add(
            ".sx-body",
            (el) => `ghost ${el.closest(".sx-ghost")?.className.baseVal ?? ""}`,
          );
          const problems: string[] = [];
          for (const { what, r } of items) {
            if (
              r.left < box.left - 1 ||
              r.right > box.right + 1 ||
              r.top < box.top - 1 ||
              r.bottom > box.bottom + 1
            )
              problems.push(`${what} leaves the stage`);
          }
          for (let a = 0; a < items.length; a++)
            for (let b = a + 1; b < items.length; b++) {
              const p = items[a].r;
              const q = items[b].r;
              const x = Math.min(p.right, q.right) - Math.max(p.left, q.left);
              const y = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
              if (x > 1 && y > 1)
                problems.push(`${items[a].what} overlaps ${items[b].what}`);
            }
          // Rendered size of every visible text: its font size in stage units times the stage's scale.
          s.querySelectorAll("text").forEach((el) => {
            if (!seen(el)) return;
            const px = parseFloat(getComputedStyle(el).fontSize) * scale;
            if (px < 12 && el.textContent !== "₿")
              problems.push(`text "${el.textContent}" at ${px.toFixed(1)}px`);
          });
          return { problems, count: items.length };
        });
        expect(report.problems, `step ${i + 1} (${STEP_IDS[i]})`).toEqual([]);
        expect(report.count).toBeGreaterThan(2);
        if (i < STEP_IDS.length - 1)
          await root.locator('[data-action="next"]').click();
      }

      // The explainer's own pieces never overlap each other.
      const boxes = await root.evaluate((el) =>
        [".psx-steps", ".psx-stage", ".psx-controls", ".psx-copy"].map(
          (sel) => {
            const r = el.querySelector(sel)!.getBoundingClientRect();
            return {
              sel,
              top: r.top,
              bottom: r.bottom,
              left: r.left,
              right: r.right,
            };
          },
        ),
      );
      for (let a = 0; a < boxes.length; a++)
        for (let b = a + 1; b < boxes.length; b++) {
          const p = boxes[a];
          const q = boxes[b];
          const x = Math.min(p.right, q.right) - Math.max(p.left, q.left);
          const y = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
          expect(x > 1 && y > 1, `${p.sel} overlaps ${q.sel}`).toBe(false);
        }
    });
  });
}

// Records short clips of every animated moment on the home page, headlessly.
// node record.mjs <url> <outDir> [only]
// Desktop 1440x900 (film) and a Pixel 7 (cards). One WebM per clip; gif.sh turns them into GIFs.
import pw from "@playwright/test";
const { chromium, devices } = pw;
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

const [url = "http://localhost:50800", out = "clips", only = ""] = process.argv.slice(2);
mkdirSync(out, { recursive: true });

const DESKTOP = { width: 1440, height: 900 };
const VIDEO = { width: 1152, height: 720 };

/** Scroll from a to b over ms, one rAF at a time, instantly (the page's own spring does the smoothing). */
const glide = (page, from, to, ms) =>
  page.evaluate(
    ([from, to, ms]) =>
      new Promise((res) => {
        const t0 = performance.now();
        const step = (now) => {
          const k = Math.min(1, (now - t0) / ms);
          scrollTo({ top: from + (to - from) * k, behavior: "instant" });
          if (k < 1) requestAnimationFrame(step);
          else res();
        };
        requestAnimationFrame(step);
      }),
    [from, to, ms],
  );

const topOf = (page, id) => page.evaluate((id) => Math.round(document.getElementById(id).getBoundingClientRect().top + scrollY), id);
const heightOf = (page, id) => page.evaluate((id) => document.getElementById(id).offsetHeight, id);
const vh = (page) => page.evaluate(() => innerHeight);

async function clip(browser, name, opts, run) {
  if (only && !name.includes(only)) return;
  const dir = join(out, "_tmp");
  mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({ ...opts, recordVideo: { dir, size: opts.video ?? VIDEO } });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  try {
    await run(page);
  } finally {
    const video = page.video();
    await ctx.close();
    const p = await video.path();
    renameSync(p, join(out, `${name}.webm`));
    console.log("clip", name);
  }
}

/** The whole chapter, from half a screen before it pins to half a screen after it unpins. */
async function chapter(page, id, speed = 640) {
  const top = await topOf(page, id);
  const h = await heightOf(page, id);
  const v = await vh(page);
  const from = top - v * 0.5;
  const to = top + h - v * 0.5;
  await page.evaluate((y) => scrollTo({ top: y, behavior: "instant" }), from);
  await page.waitForTimeout(700);
  await glide(page, from, to, ((to - from) / speed) * 1000);
  await page.waitForTimeout(900);
}

const browser = await chromium.launch();
const desktop = { viewport: DESKTOP, colorScheme: "dark", deviceScaleFactor: 1 };
const phone = { ...devices["Pixel 7"], colorScheme: "dark", video: { width: 412, height: 915 } };

// Hero: the arrival, the line, the idle, then the scroll into the invitation (the first hand-off).
await clip(browser, "desktop-hero", desktop, async (page) => {
  await page.waitForTimeout(5200);
  const inv = await topOf(page, "invite");
  const v = await vh(page);
  await glide(page, 0, inv + v * 0.3, 4200);
  await page.waitForTimeout(900);
});
await clip(browser, "desktop-invite", desktop, (page) => chapter(page, "invite"));
await clip(browser, "desktop-dht", desktop, (page) => chapter(page, "dht"));
// The statement and the second act's opening.
await clip(browser, "desktop-agree", desktop, async (page) => {
  const dht = await topOf(page, "dht");
  const dhtH = await heightOf(page, "dht");
  const agree = await topOf(page, "agree");
  const agreeH = await heightOf(page, "agree");
  const v = await vh(page);
  const from = dht + dhtH - v;
  const to = agree + agreeH - v * 0.5;
  await page.evaluate((y) => scrollTo({ top: y, behavior: "instant" }), from);
  await page.waitForTimeout(700);
  await glide(page, from, to, ((to - from) / 720) * 1000);
  await page.waitForTimeout(900);
});
await clip(browser, "desktop-alive", desktop, (page) => chapter(page, "alive"));
await clip(browser, "desktop-open", desktop, (page) => chapter(page, "open"));
// The product rows and the deck.
await clip(browser, "desktop-next", desktop, async (page) => {
  const top = await topOf(page, "next");
  const h = await heightOf(page, "next");
  await page.evaluate((y) => scrollTo({ top: y, behavior: "instant" }), top - 200);
  await page.waitForTimeout(600);
  await glide(page, top - 200, top + h - 700, 9000);
  await page.waitForTimeout(600);
});
await clip(browser, "desktop-deck", desktop, async (page) => {
  await page.evaluate(() => document.getElementById("wallets").scrollIntoView({ block: "center", behavior: "instant" }));
  await page.waitForTimeout(9500);
});
// The rail: pointing at it, then a long jump (the swarm).
await clip(browser, "desktop-rail-swarm", desktop, async (page) => {
  const inv = await topOf(page, "invite");
  await page.evaluate((y) => scrollTo({ top: y + 400, behavior: "instant" }), inv);
  await page.waitForTimeout(800);
  await page.mouse.move(700, 880);
  await page.waitForTimeout(500);
  await page.mouse.move(720, 884);
  await page.waitForTimeout(1200);
  const mark = page.locator(".rail-mark").nth(7);
  await mark.hover();
  await page.waitForTimeout(600);
  await mark.click();
  await page.waitForTimeout(2600);
});
await clip(browser, "desktop-finale", desktop, async (page) => {
  await page.evaluate(() => document.getElementById("download").scrollIntoView({ block: "start", behavior: "instant" }));
  await page.waitForTimeout(400);
  await page.evaluate(() => scrollBy({ top: -40, behavior: "instant" }));
  await page.waitForTimeout(15500);
  await page.mouse.move(600, 600);
  await page.locator(".fin-dl").first().hover();
  await page.waitForTimeout(900);
});
await clip(browser, "desktop-footer-pet", desktop, async (page) => {
  await page.evaluate(() => scrollTo({ top: document.body.scrollHeight, behavior: "instant" }));
  await page.waitForTimeout(500);
  for (let i = 0; i < 40; i++) {
    await page.mouse.move(300 + i * 20, 500 + Math.sin(i / 4) * 120);
    await page.waitForTimeout(90);
  }
  await page.waitForTimeout(3500);
});
await clip(browser, "desktop-micro", desktop, async (page) => {
  await page.waitForTimeout(1200);
  const a = page.locator(".hero-actions .btn").first();
  const b = page.locator(".hero-actions .btn").nth(1);
  await a.hover();
  await page.waitForTimeout(700);
  await b.hover();
  await page.waitForTimeout(700);
  await page.locator(".hero-follow .link-arrow").hover();
  await page.waitForTimeout(700);
  await page.keyboard.press("Tab");
  await page.waitForTimeout(500);
  await page.keyboard.press("Tab");
  await page.waitForTimeout(500);
  await page.keyboard.press("Tab");
  await page.waitForTimeout(800);
});

// Phone: cards. Each chapter's figures come into view one by one.
async function cards(page, id) {
  const n = await page.locator(`#${id} .scene-static-figure`).count();
  const v = await vh(page);
  let y = await page.evaluate(() => scrollY);
  for (let i = 0; i < n; i++) {
    const fig = page.locator(`#${id} .scene-static-figure`).nth(i);
    const top = await fig.evaluate((el) => el.getBoundingClientRect().top + scrollY);
    const h = await fig.evaluate((el) => el.offsetHeight);
    const target = Math.round(top - (v - h) / 2 - 20);
    await glide(page, y, target, Math.max(500, Math.abs(target - y) / 1.4));
    y = target;
    await page.waitForTimeout(2300);
  }
}
await clip(browser, "phone-hero", phone, async (page) => {
  await page.waitForTimeout(4500);
  const inv = await topOf(page, "invite");
  await glide(page, 0, inv - 60, 2400);
  await page.waitForTimeout(800);
});
for (const id of ["invite", "dht", "agree", "alive", "open"]) {
  await clip(browser, `phone-${id}`, phone, async (page) => {
    const top = await topOf(page, id);
    await page.evaluate((y) => scrollTo({ top: y - 60, behavior: "instant" }), top);
    await page.waitForTimeout(600);
    await cards(page, id);
  });
}
await clip(browser, "phone-deck", phone, async (page) => {
  await page.evaluate(() => document.getElementById("wallets").scrollIntoView({ block: "center", behavior: "instant" }));
  await page.waitForTimeout(9000);
});
await clip(browser, "phone-finale", phone, async (page) => {
  await page.evaluate(() => document.getElementById("download").scrollIntoView({ block: "start", behavior: "instant" }));
  await page.waitForTimeout(14500);
});

// Reduced motion: the whole page, top to bottom, as stills.
await clip(browser, "desktop-reduced-motion", { ...desktop, reducedMotion: "reduce" }, async (page) => {
  const total = await page.evaluate(() => document.body.scrollHeight - innerHeight);
  await page.waitForTimeout(800);
  await glide(page, 0, total, 14000);
  await page.waitForTimeout(600);
});

await browser.close();

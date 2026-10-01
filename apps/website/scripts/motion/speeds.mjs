// Records the story's first act at several window sizes and scroll speeds, headlessly, so builds can be compared.
// node speeds.mjs <url> <outDir> [sizes] [speeds]
//   sizes:  comma list of WxH or "phone" (a Pixel 7), default 1440x900,1280x800,1009x1239,1024x1366,900x1200,phone
//   speeds: comma list of slow, flick, reverse (default all three)
// One WebM per size and speed, named <size>-<speed>.webm, with <size>-<speed>.json saying when in the clip the
// scrolling starts ({ "start": seconds }), so stack.sh can line builds up. Every scroll is written with behavior "instant" once per
// frame, so what moves on screen is the page's own smoothing, never the browser's smooth scrolling.
//   slow:    a reader's pace, 0.8 viewport heights a second, from the top to the end of the DHT chapter.
//   flick:   four trackpad flings down (2.2 viewport heights each, easing out over about a second), 1.4 s apart.
//   reverse: from the end of the DHT chapter, four flings back up.
import pw from "@playwright/test";
const { chromium, devices } = pw;
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [url = "http://localhost:52000", out = "speeds", sizeArg = "", speedArg = ""] = process.argv.slice(2);
const SIZES = (sizeArg || "1440x900,1280x800,1009x1239,1024x1366,900x1200,phone").split(",");
const SPEEDS = (speedArg || "slow,flick,reverse").split(",");
mkdirSync(out, { recursive: true });

/**
 * Scroll one way, one instant write per frame: a straight glide (`seconds` long) or a trackpad fling (fast at first,
 * easing out over about a second: exponential decay, cut at 98%).
 */
const drive = (page, move) =>
  page.evaluate(
    ({ kind, from, distance, seconds }) =>
      new Promise((res) => {
        const tau = 0.3;
        const end = kind === "fling" ? tau * Math.log(50) : seconds;
        const t0 = performance.now();
        const step = (now) => {
          const t = (now - t0) / 1000;
          const k = kind === "fling" ? Math.min(1, (1 - Math.exp(-t / tau)) / 0.98) : Math.min(1, t / seconds);
          scrollTo({ top: from + distance * k, behavior: "instant" });
          if (t >= end) return res();
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    move,
  );
const glide = (page, from, to, seconds) => drive(page, { kind: "glide", from, distance: to - from, seconds });
const fling = (page, from, distance) => drive(page, { kind: "fling", from, distance });

const box = (w, h) => {
  const k = Math.min(1, 960 / w, 900 / h);
  return { width: Math.round((w * k) / 2) * 2, height: Math.round((h * k) / 2) * 2 };
};

const browser = await chromium.launch();
for (const size of SIZES) {
  const opts =
    size === "phone"
      ? { ...devices["Pixel 7"], colorScheme: "dark", recordVideo: { dir: join(out, "_tmp"), size: { width: 412, height: 915 } } }
      : (() => {
          const [w, h] = size.split("x").map(Number);
          return { viewport: { width: w, height: h }, colorScheme: "dark", deviceScaleFactor: 1, recordVideo: { dir: join(out, "_tmp"), size: box(w, h) } };
        })();
  for (const speed of SPEEDS) {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    const opened = Date.now();
    let start = 0;
    await page.goto(url, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    try {
      const at = await page.evaluate(() => {
        const top = (id) => document.getElementById(id).getBoundingClientRect().top + scrollY;
        const dht = document.getElementById("dht");
        return { invite: top("invite"), end: top("dht") + dht.offsetHeight - innerHeight, vh: innerHeight };
      });
      await page.waitForTimeout(3500);
      start = (Date.now() - opened) / 1000;
      if (speed === "slow") {
        await glide(page, 0, at.end, at.end / (0.8 * at.vh));
        await page.waitForTimeout(1500);
      } else if (speed === "flick") {
        let y = 0;
        for (let i = 0; i < 4; i++) {
          const d = Math.min(2.2 * at.vh, at.end - y);
          await fling(page, y, d);
          y += d;
          await page.waitForTimeout(1400);
        }
      } else if (speed === "reverse") {
        await page.evaluate((y) => scrollTo({ top: y, behavior: "instant" }), at.end);
        await page.waitForTimeout(2000);
        let y = at.end;
        for (let i = 0; i < 4; i++) {
          const d = Math.min(2.2 * at.vh, y);
          await fling(page, y, -d);
          y -= d;
          await page.waitForTimeout(1400);
        }
      }
    } finally {
      const video = page.video();
      await ctx.close();
      renameSync(await video.path(), join(out, `${size}-${speed}.webm`));
      writeFileSync(join(out, `${size}-${speed}.json`), JSON.stringify({ start }));
      console.log("clip", size, speed);
    }
  }
}
await browser.close();

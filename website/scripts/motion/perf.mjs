// Frame times on the home page, headlessly, on a throttled CPU.
// node perf.mjs <url> [cpu=4] [json-out]
// Desktop 1440x900 film at 4x CPU throttling (a mid-range laptop next to this Mac) and a Pixel 7 at 6x.
// A rAF sampler records frame deltas while the page is scrolled at a reader's pace, one rAF at a time;
// CDP Performance metrics count layouts and style recalcs over the same stretch; first-load weight from responses.
import pw from "@playwright/test";
const { chromium, devices } = pw;
import { writeFileSync } from "node:fs";

const [url = "http://localhost:50800", cpuArg = "4", jsonOut = ""] = process.argv.slice(2);
const CPU = Number(cpuArg);

const SAMPLER = `
  window.__ft = { frames: [], on: false };
  (function loop(prev) {
    requestAnimationFrame((now) => {
      if (window.__ft.on && prev) window.__ft.frames.push(now - prev);
      loop(now);
    });
  })(0);
`;

function stats(frames) {
  if (!frames.length) return null;
  const s = [...frames].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const total = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    ms: Math.round(total),
    p50: +q(0.5).toFixed(1),
    p95: +q(0.95).toFixed(1),
    max: +q(1).toFixed(1),
    over17: +((100 * s.filter((f) => f > 17.5).length) / s.length).toFixed(1),
    over34: +((100 * s.filter((f) => f > 34).length) / s.length).toFixed(1),
    fps: +((1000 * s.length) / total).toFixed(1),
  };
}

async function metrics(cdp) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const get = (n) => metrics.find((m) => m.name === n)?.value ?? 0;
  return { layouts: get("LayoutCount"), recalcs: get("RecalcStyleCount"), layoutMs: get("LayoutDuration") * 1000, styleMs: get("RecalcStyleDuration") * 1000, scriptMs: get("ScriptDuration") * 1000 };
}

async function measure(page, cdp, label, run) {
  const before = await metrics(cdp);
  await page.evaluate(() => {
    window.__ft.frames = [];
    window.__ft.on = true;
  });
  await run();
  const frames = await page.evaluate(() => {
    window.__ft.on = false;
    return window.__ft.frames;
  });
  const after = await metrics(cdp);
  const d = (k) => Math.round(after[k] - before[k]);
  const s = stats(frames);
  const row = { label, ...s, layouts: d("layouts"), recalcs: d("recalcs"), layoutMs: d("layoutMs"), styleMs: d("styleMs"), scriptMs: d("scriptMs") };
  console.log(
    `${label.padEnd(26)} fps ${String(s.fps).padStart(5)}  p50 ${String(s.p50).padStart(5)}  p95 ${String(s.p95).padStart(5)}  max ${String(s.max).padStart(6)}  >17ms ${String(s.over17).padStart(5)}%  >34ms ${String(s.over34).padStart(5)}%  layouts ${row.layouts}  style ${row.recalcs}  layout ${row.layoutMs}ms  script ${row.scriptMs}ms`,
  );
  return row;
}

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

const browser = await chromium.launch();
const results = { url, cpu: CPU, desktop: [], phone: [], load: null };

// First load: bytes over the wire for the home, as served (compressed), by kind.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  const kinds = new Map();
  const sizes = {};
  cdp.on("Network.responseReceived", (e) => kinds.set(e.requestId, { type: e.response.mimeType, url: e.response.url }));
  cdp.on("Network.loadingFinished", (e) => {
    const k = kinds.get(e.requestId);
    if (!k || !k.url.startsWith(new URL(url).origin)) return;
    const kind = k.type.includes("javascript") ? "js" : k.type.includes("css") ? "css" : k.type.includes("image") ? "img" : k.type.includes("font") ? "font" : k.type.includes("html") ? "html" : k.type.includes("x-component") ? "prefetch" : "other";
    sizes[kind] = (sizes[kind] ?? 0) + e.encodedDataLength;
  });
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const kb = Object.fromEntries(Object.entries(sizes).map(([k, v]) => [k, Math.round(v / 1024)]));
  console.log("first load, KB on the wire:", JSON.stringify(kb));
  results.load = kb;
  await ctx.close();
}

// Desktop film.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU });
  await page.addInitScript(SAMPLER);
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  console.log(`\n== desktop 1440x900, CPU x${CPU} ==`);
  results.desktop.push(await measure(page, cdp, "hero idle (3 s)", () => page.waitForTimeout(3000)));
  const vh = 900;
  for (const id of ["invite", "dht", "agree", "alive", "open"]) {
    const top = await topOf(page, id);
    const h = await heightOf(page, id);
    const from = top - vh * 0.5;
    const to = top + h - vh * 0.5;
    await page.evaluate((y) => scrollTo({ top: y, behavior: "instant" }), from);
    await page.waitForTimeout(600);
    results.desktop.push(await measure(page, cdp, `${id} scroll`, () => glide(page, from, to, ((to - from) / 700) * 1000)));
    results.desktop.push(await measure(page, cdp, `${id} settle (1 s)`, () => page.waitForTimeout(1000)));
  }
  {
    const top = await topOf(page, "next");
    const h = await heightOf(page, "next");
    await page.evaluate((y) => scrollTo({ top: y, behavior: "instant" }), top - 300);
    await page.waitForTimeout(500);
    results.desktop.push(await measure(page, cdp, "next scroll", () => glide(page, top - 300, top + h - 600, 6000)));
  }
  await page.evaluate(() => document.getElementById("wallets").scrollIntoView({ block: "center", behavior: "instant" }));
  await page.waitForTimeout(800);
  results.desktop.push(await measure(page, cdp, "deck idle (5 s)", () => page.waitForTimeout(5000)));
  await page.evaluate(() => document.getElementById("download").scrollIntoView({ block: "start", behavior: "instant" }));
  await page.waitForTimeout(300);
  results.desktop.push(await measure(page, cdp, "finale (6 s)", () => page.waitForTimeout(6000)));
  await ctx.close();
}

// Phone cards.
{
  const cpu = Math.max(CPU, 6);
  const ctx = await browser.newContext({ ...devices["Pixel 7"], colorScheme: "dark" });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
  await page.addInitScript(SAMPLER);
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  console.log(`\n== Pixel 7, CPU x${cpu} ==`);
  results.phone.push(await measure(page, cdp, "hero idle (3 s)", () => page.waitForTimeout(3000)));
  const vh = await page.evaluate(() => innerHeight);
  for (const id of ["invite", "dht", "agree", "alive", "open"]) {
    const top = await topOf(page, id);
    const h = await heightOf(page, id);
    await page.evaluate((y) => scrollTo({ top: y - 80, behavior: "instant" }), top);
    await page.waitForTimeout(500);
    results.phone.push(await measure(page, cdp, `${id} cards`, async () => {
      await glide(page, top - 80, top + h - vh, ((h - vh + 80) / 500) * 1000);
      await page.waitForTimeout(1500);
    }));
  }
  await page.evaluate(() => document.getElementById("wallets").scrollIntoView({ block: "center", behavior: "instant" }));
  await page.waitForTimeout(800);
  results.phone.push(await measure(page, cdp, "deck idle (5 s)", () => page.waitForTimeout(5000)));
  await page.evaluate(() => document.getElementById("download").scrollIntoView({ block: "start", behavior: "instant" }));
  await page.waitForTimeout(300);
  results.phone.push(await measure(page, cdp, "finale (6 s)", () => page.waitForTimeout(6000)));
  await ctx.close();
}

await browser.close();
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 2));

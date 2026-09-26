// Draws the film frame by frame: serves film/ with Vite, opens it in headless Chromium, seeks every frame and
// takes a screenshot, then encodes the frames.
//   node media/launch-video/render.mjs [--format 16x9|9x16|1x1] [--fps 60] [--workers 4]      → out/<format>/picture.mp4
//   node media/launch-video/render.mjs --stills 0,3.3,13.4 [--format …]                        → out/<format>/stills/*.jpg
//   node media/launch-video/render.mjs --sheet [--format …]                                    → out/<format>/sheet.jpg (a still per bar)
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
import { BAR, DURATION } from "./timeline.js";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const format = arg("format", "16x9");
const FPS = Number(arg("fps", 60));
const WORKERS = Number(arg("workers", 4));
const [width, height] = { "16x9": [1920, 1080], "9x16": [1080, 1920], "1x1": [1080, 1080] }[format];
const out = join(here, "out", format);
mkdirSync(out, { recursive: true });

const server = await createServer({ configFile: join(here, "vite.config.ts"), server: { port: Number(process.env.FILM_PORT ?? 5391) } });
await server.listen();
const url = `http://localhost:${server.config.server.port}/?format=${format}`;
const browser = await chromium.launch({ headless: true });
async function open() {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.on("pageerror", (error) => { console.error("page error:", error.message); process.exitCode = 1; });
  await page.goto(url);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 120_000 });
  return page;
}
async function grab(page, t, path) {
  await page.evaluate((time) => window.seek(time), t);
  await page.screenshot({ path, type: "jpeg", quality: 94 });
}

try {
  if (process.argv.includes("--stills") || process.argv.includes("--sheet")) {
    const sheet = process.argv.includes("--sheet");
    const times = sheet ? Array.from({ length: Math.round(DURATION / BAR) }, (_, i) => Number((i * BAR + BAR * 0.7).toFixed(3))) : arg("stills").split(",").map(Number);
    const dir = join(out, sheet ? "sheet" : "stills");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const page = await open();
    for (const t of times) await grab(page, t, join(dir, `${t.toFixed(3).padStart(7, "0")}.jpg`));
    if (sheet) {
      execFileSync("ffmpeg", ["-y", "-v", "error", "-pattern_type", "glob", "-i", join(dir, "*.jpg"), "-vf",
        `scale=${Math.round(width / 4)}:-1,drawtext=text='%{eif\\:n+1\\:d}':x=10:y=8:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6,tile=${format === "9x16" ? "8x3" : "4x6"}:padding=6:color=black`,
        "-frames:v", "1", join(out, "sheet.jpg")]);
      console.log("✓", join(out, "sheet.jpg"));
    } else console.log("✓", dir);
  } else {
    const dir = join(out, "frames");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const total = Math.round(DURATION * FPS);
    let next = 0, done = 0;
    const started = Date.now();
    await Promise.all(Array.from({ length: WORKERS }, async () => {
      const page = await open();
      while (next < total) {
        const n = next++;
        await grab(page, n / FPS, join(dir, `${String(n).padStart(6, "0")}.jpg`));
        if (++done % 300 === 0) console.log(`${done}/${total} frames, ${Math.round((Date.now() - started) / 1000)} s`);
      }
      await page.close();
    }));
    execFileSync("ffmpeg", ["-y", "-v", "error", "-framerate", String(FPS), "-i", join(dir, "%06d.jpg"),
      "-c:v", "libx264", "-preset", "slow", "-crf", "15", "-pix_fmt", "yuv420p", "-r", String(FPS), join(out, "picture.mp4")], { stdio: "inherit" });
    console.log("✓", join(out, "picture.mp4"));
  }
} finally {
  await browser.close();
  await server.close();
}

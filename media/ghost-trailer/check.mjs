// Measures the finished trailer, since nobody here can listen: the voice over the score while it speaks, each sound's
// attack against the moment the picture gave it, the frame where the picture moves at that moment, and the loudness.
//   node media/ghost-trailer/check.mjs [--format 16x9]      → out/<format>/sync.md
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decode, RATE } from "../launch-video/beats.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const format = arg("format", "16x9");
const out = join(here, "out", format);
const film = join(here, "out", `ghostly-trailer-${format}.mp4`);
const { lines } = JSON.parse(readFileSync(join(here, "out", "timeline.json"), "utf8"));
const sounds = JSON.parse(readFileSync(join(out, "sounds.json"), "utf8"));
const ms = (s) => `${s >= 0 ? "+" : ""}${(s * 1000).toFixed(1)}`;
const rms = (x, a, b) => { let sum = 0; const i0 = Math.round(a * RATE), i1 = Math.round(b * RATE); for (let i = i0; i < i1; i++) sum += x[i] ** 2; return 10 * Math.log10(sum / Math.max(1, i1 - i0) + 1e-12); };

// 1. The voice against the ducked score, line by line.
const voice = decode(join(out, "voice.wav")), score = decode(join(out, "score.wav")), fx = decode(join(out, "fx.wav"));
const report = ["# Trailer report", "", "## Voice over the score", "", "| Line | Voice (dBFS RMS) | Score under it | Voice above score |", "|---|---|---|---|"];
const gaps = [];
for (const l of lines) {
  const v = rms(voice, l.start, l.end), m = rms(score, l.start, l.end);
  gaps.push(v - m);
  report.push(`| ${l.id} | ${v.toFixed(1)} | ${m.toFixed(1)} | ${(v - m).toFixed(1)} dB |`);
}
report.push("", `Lowest: ${Math.min(...gaps).toFixed(1)} dB; median ${gaps.sort((a, b) => a - b)[gaps.length >> 1].toFixed(1)} dB.`);

// 2. Each sound's attack in the effects stem, and the frame where the picture changes.
const [w, h] = [96, format === "9x16" ? 170 : format === "1x1" ? 96 : 54];
const raw = execFileSync("ffmpeg", ["-v", "error", "-i", film, "-vf", `scale=${w}:${h},format=gray`, "-f", "rawvideo", "-"], { maxBuffer: 1 << 30 });
const size = w * h, frames = raw.length / size, fps = 60;
const change = Array.from({ length: frames }, (_, f) => { if (!f) return 0; let sum = 0; for (let i = 0; i < size; i++) sum += Math.abs(raw[f * size + i] - raw[(f - 1) * size + i]); return sum / size; });
function onsetNear(x, t) {
  const a = Math.max(0, Math.round((t - 0.1) * RATE)), b = Math.min(x.length, Math.round((t + 0.15) * RATE));
  let peak = 0; for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(x[i]));
  for (let i = a; i < b; i++) if (Math.abs(x[i]) >= peak * 0.1) return i / RATE;
  return NaN;
}
function motionNear(t) {
  const at = Math.round(t * fps);
  const before = change.slice(Math.max(1, at - 15), Math.max(2, at - 1)).sort((x, y) => x - y);
  const usual = before[before.length >> 1] ?? 0;
  for (let f = Math.max(1, at - 6); f <= Math.min(frames - 1, at + 12); f++) if (change[f] > Math.max(0.12, usual * 2.5)) return f / fps;
  return NaN;
}
report.push("", "## Sounds on the picture", "", "| Time (s) | Sound | Attack measured | Picture starts moving |", "|---|---|---|---|");
let worst = 0;
for (const s of sounds) {
  const heard = onsetNear(fx, s.at) - s.at, seen = motionNear(s.at) - s.at;
  if (!Number.isNaN(heard)) worst = Math.max(worst, Math.abs(heard));
  report.push(`| ${s.at.toFixed(3)} | ${s.sound} | ${ms(heard)} ms | ${Number.isNaN(seen) ? "continuous motion" : `${ms(seen)} ms`} |`);
}
report.push("", `Worst attack: ${(worst * 1000).toFixed(1)} ms off its moment.`);

// 3. Loudness.
const loud = spawnSync("ffmpeg", ["-hide_banner", "-i", film, "-map", "0:a", "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" }).stderr;
const summary = loud.slice(loud.lastIndexOf("Summary:"));
const pick = (label) => summary.match(new RegExp(`${label}:\\s+(-?[\\d.]+)`))?.[1];
report.push("", "## Loudness", "", `Integrated ${pick("I")} LUFS, range ${pick("LRA")} LU, true peak ${pick("Peak")} dBTP.`);
writeFileSync(join(out, "sync.md"), report.join("\n") + "\n");
console.log(report.join("\n"));

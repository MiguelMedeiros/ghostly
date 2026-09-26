// Measures the finished film against its grid, since nobody here can listen: the score's beats, where each cue's
// attack really is in the cues stem, where the picture really starts moving at each moment, and the loudness.
//   node media/launch-video/check.mjs [--format 16x9]      → out/<format>/sync.md
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decode, grid, RATE } from "./beats.mjs";
import { BAR, BEAT, BPM, CUES, M } from "./timeline.js";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const format = arg("format", "16x9");
const out = join(here, "out", format);
const film = join(here, "out", `ghostly-v1.0-${format}.mp4`);
const ms = (s) => `${s >= 0 ? "+" : ""}${(s * 1000).toFixed(1)}`;
const barBeat = (t) => { const beats = t / BEAT; return `${Math.floor(beats / 4) + 1}.${((beats % 4) + 1).toFixed(beats % 1 ? 2 : 0)}`; };
const names = new Map(Object.entries(M).flatMap(([name, v]) => Array.isArray(v) ? v.map((t, i) => [t, `${name}[${i}]`]) : [[v, name]]));

// 1. The score: its measured tempo and how far its beats sit from the film's grid.
const score = decode(join(out, "music.wav"));
const lines = ["# Sync report", "", `Film grid: ${BPM} BPM, beat ${(BEAT * 1000).toFixed(2)} ms, bar ${BAR.toFixed(4)} s.`, "", "## Score", "", "| Part | Measured BPM | First beat | Beats within 10 ms of the grid | Median offset |", "|---|---|---|---|---|"];
for (const [part, from, to] of [["Intro (bars 1-7)", 0, M.gap], ["Drop (bars 8-19)", M.drop, M.servers], ["Bar 23", M.words[0], M.gap2]]) {
  const g = grid(score, { bpm: BPM, from, to });
  const beats = g.beats.filter((b) => b.t >= from && b.t < to);
  const offsets = beats.map((b) => { const nearest = Math.round(b.onset / BEAT) * BEAT; return b.onset - nearest; }).sort((a, b) => a - b);
  const close = offsets.filter((o) => Math.abs(o) <= 0.01).length;
  lines.push(`| ${part} | ${g.bpm} | ${ms(g.first - Math.round(g.first / BEAT) * BEAT)} ms from the grid | ${close}/${offsets.length} | ${ms(offsets[offsets.length >> 1])} ms |`);
}

// 2. The cues: the attack found in the cues stem around each moment.
const cues = decode(join(out, "cues.wav"));
function onsetNear(samples, t) {
  const a = Math.max(0, Math.round((t - 0.1) * RATE)), b = Math.min(samples.length, Math.round((t + 0.15) * RATE));
  let peak = 0;
  for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(samples[i]));
  for (let i = a; i < b; i++) if (Math.abs(samples[i]) >= peak * 0.1) return i / RATE;
  return NaN;
}

// 3. The picture: the first frame that changes at each moment (a grey 1/10 size copy, frame against frame).
const [w, h] = [96, format === "9x16" ? 170 : format === "1x1" ? 96 : 54];
const raw = execFileSync("ffmpeg", ["-v", "error", "-i", film, "-vf", `scale=${w}:${h},format=gray`, "-f", "rawvideo", "-"], { maxBuffer: 1 << 30 });
const size = w * h, frames = raw.length / size;
const fps = Number(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", film]).toString().trim().replace(/,$/, "").split("/").reduce((a, b) => a / b));
const change = Array.from({ length: frames }, (_, f) => {
  if (!f) return 0;
  let sum = 0;
  for (let i = 0; i < size; i++) sum += Math.abs(raw[f * size + i] - raw[(f - 1) * size + i]);
  return sum / size;
});
function motionNear(t) {
  // The first frame around `t` that changes clearly more than the frames just before it (the glow's breathing and
  // the cards' float move a little on every frame).
  const at = Math.round(t * fps);
  const before = change.slice(Math.max(1, at - 15), Math.max(2, at - 1)).sort((x, y) => x - y);
  const usual = before[before.length >> 1] ?? 0;
  for (let f = Math.max(1, at - 6); f <= Math.min(frames - 1, at + 9); f++) if (change[f] > Math.max(0.3, usual * 3)) return f / fps;
  return NaN;
}

lines.push("", "## Cues and motion on the beats", "", "Each cue's file starts so its attack lands on its moment; the table measures the rendered stems.", "",
  "| Moment | Bar.beat | Time (s) | Off the grid | Cue | Cue attack measured | Motion measured |", "|---|---|---|---|---|---|---|");
let worstCue = 0, worstMotion = 0;
for (const cue of [...CUES].sort((a, b) => a.at - b.at)) {
  const grid = cue.at - Math.round(cue.at / (BEAT / 4)) * (BEAT / 4);
  const heard = onsetNear(cues, cue.at) - cue.at, seen = motionNear(cue.at) - cue.at;
  worstCue = Math.max(worstCue, Math.abs(heard)); if (!Number.isNaN(seen)) worstMotion = Math.max(worstMotion, Math.abs(seen));
  lines.push(`| ${names.get(cue.at) ?? ""} | ${barBeat(cue.at)} | ${cue.at.toFixed(4)} | ${ms(grid)} ms | ${cue.sound} | ${ms(heard)} ms | ${Number.isNaN(seen) ? "no clear change" : `${ms(seen)} ms`} |`);
}
lines.push("", `Worst cue attack: ${(worstCue * 1000).toFixed(1)} ms. Worst motion start: ${(worstMotion * 1000).toFixed(1)} ms (one frame is ${(1000 / fps).toFixed(1)} ms).`);

// 4. The ducking: the score just after each cue against the same place one beat earlier (the same kick pattern).
const rms = (a, b) => { let sum = 0; for (let i = Math.round(a * RATE); i < Math.round(b * RATE); i++) sum += score[i] ** 2; return 10 * Math.log10(sum / ((b - a) * RATE) + 1e-12); };
const ducks = CUES.filter((c) => c.at > BEAT).map((c) => rms(c.at + 0.02, c.at + 0.2) - rms(c.at - BEAT + 0.02, c.at - BEAT + 0.2)).sort((a, b) => a - b);
lines.push("", "## Ducking", "", `The score under a cue against one beat earlier: median ${ducks[ducks.length >> 1].toFixed(1)} dB (the extremes, ${ducks[0].toFixed(1)} and ${ducks.at(-1).toFixed(1)} dB, are the silent beats and the breakdown's edges).`);

// 5. Loudness of the film's own audio track.
const loud = spawnSync("ffmpeg", ["-hide_banner", "-i", film, "-map", "0:a", "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" }).stderr;
const summary = loud.slice(loud.lastIndexOf("Summary:"));
const pick = (label) => summary.match(new RegExp(`${label}:\\s+(-?[\\d.]+)`))?.[1];
lines.push("", "## Loudness", "", `Integrated ${pick("I")} LUFS, range ${pick("LRA")} LU, true peak ${pick("Peak")} dBTP.`);
writeFileSync(join(out, "sync.md"), lines.join("\n") + "\n");
console.log(lines.join("\n"));

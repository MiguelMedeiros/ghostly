// The soundtrack: the score laid on the film's grid, the app's own cues on their moments, the score ducked under
// the cues, the whole at -14 LUFS; then the picture and the sound in one file.
//   node media/launch-video/mix.mjs [--format 16x9]      → out/<format>/{music,cues,mix}.wav and out/ghostly-v1.0-<format>.mp4
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decode, grid, RATE } from "./beats.mjs";
import { BEAT, BPM, CUES, DURATION, M } from "./timeline.js";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const format = arg("format", "16x9");
const out = join(here, "out", format);
const music = (name) => join(here, "cache", "music", `${name}.mp3`);
const sound = (name) => join(here, "..", "..", "src", "assets", "sounds", `${name}.mp3`);
const ffmpeg = (args) => execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1 << 26 }).toString();

/** Where a sound's attack is: the first moment it reaches a tenth of its peak. */
export function attack(file) {
  const s = decode(file);
  let peak = 0;
  for (const v of s) peak = Math.max(peak, Math.abs(v));
  let i = 0;
  while (i < s.length && Math.abs(s[i]) < peak * 0.1) i++;
  return i / RATE;
}
/** Where a riser stops dead: the end of its last loud 10 ms. */
function stop(file) {
  const s = decode(file), w = RATE / 100;
  let peak = 0;
  for (const v of s) peak = Math.max(peak, Math.abs(v));
  let last = 0;
  for (let i = 0; i + w <= s.length; i += w) {
    let m = 0;
    for (let j = i; j < i + w; j++) m = Math.max(m, Math.abs(s[j]));
    if (m > peak * 0.3) last = (i + w) / RATE;
  }
  return last;
}

// The score's own grids: the intro and the drop were asked for at 128 BPM; each is measured and stretched onto it.
const intro = grid(decode(music("intro")), { bpm: BPM }), drop = grid(decode(music("drop")), { bpm: BPM });
const speed = (g) => BPM / g.bpm;

/** A piece of a score file from its beat `fromBeat` for `seconds` of film, stretched to 128 BPM, filtered, placed at `place`. */
const inputs = [];
const chains = [];
function piece(file, g, fromBeat, seconds, place, filters = [], fade = 0.012) {
  const n = inputs.push(file) - 1;
  const start = g.first + fromBeat * g.beat, length = seconds * speed(g);
  const chain = [`atrim=start=${start.toFixed(5)}:duration=${length.toFixed(5)}`, "asetpts=PTS-STARTPTS", `atempo=${speed(g).toFixed(6)}`,
    ...filters, `afade=t=in:d=0.004`, `afade=t=out:st=${(seconds - fade).toFixed(4)}:d=${fade}`, `adelay=${Math.round(place * 1000)}:all=1`];
  chains.push(`[${n}:a]aformat=sample_rates=48000:channel_layouts=stereo,${chain.join(",")}[m${chains.length}]`);
}
function hit(file, place, db, filters = []) {
  const n = inputs.push(file) - 1;
  chains.push(`[${n}:a]aformat=sample_rates=48000:channel_layouts=stereo,${[...filters, `volume=${db}dB`, `adelay=${Math.max(0, Math.round(place * 1000))}:all=1`].join(",")}[m${chains.length}]`);
}

// Bars 1-7: the intro's hook, silent on the last beat before the drop.
piece(music("intro"), intro, 0, M.gap, 0, [], 0.03);
// Bars 8-19: the drop at full energy; 20-21 the breakdown (a low pass); 22 opening up; 23 its groove again, silent on
// the last beat before the final hit.
piece(music("drop"), drop, 0, M.servers - M.drop, M.drop);
piece(music("drop"), drop, (M.servers - M.drop) / BEAT, M.safe - M.servers, M.servers, ["lowpass=f=380:p=2", "volume=-2dB"]);
piece(music("drop"), drop, (M.safe - M.drop) / BEAT, M.words[0] - M.safe, M.safe, ["lowpass=f=1400:p=2", "volume=-1dB"]);
piece(music("drop"), drop, 13 * 4, M.gap2 - M.words[0], M.words[0], [], 0.03);
// Bar 24: the drop's first bar again as the last hit, ringing out.
piece(music("drop"), drop, 0, DURATION - M.end, M.end, ["aecho=0.8:0.6:160|320:0.35|0.2", `afade=t=out:st=0.25:d=${(DURATION - M.end - 0.25).toFixed(3)}:curve=exp`]);
// The risers stop dead on the drop and on the last hit; an impact on both; a downlifter into the breakdown.
const riserStop = stop(music("riser"));
hit(music("riser"), M.drop - riserStop, -4);
hit(music("riser"), M.end - riserStop, -4);
hit(music("impact"), M.drop - attack(music("impact")), -9);
hit(music("impact"), M.end - attack(music("impact")), -8);
hit(music("downlift"), M.servers - attack(music("downlift")), -8);
const scoreParts = chains.length;

// The app's cues, each placed so its attack lands on its moment. `CUE_DB` sets the cues against the score.
const CUE_DB = Number(arg("cues-db", -5));
const placed = CUES.map((cue) => ({ ...cue, attack: attack(sound(cue.sound)) }));
for (const cue of placed) {
  const n = inputs.push(sound(cue.sound)) - 1;
  chains.push(`[${n}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${cue.db + CUE_DB}dB,adelay=${Math.round((cue.at - cue.attack) * 1000)}:all=1[m${chains.length}]`);
}
const label = (from, to) => Array.from({ length: to - from }, (_, i) => `[m${from + i}]`).join("");
const graph = [
  ...chains,
  `${label(0, scoreParts)}amix=inputs=${scoreParts}:normalize=0:duration=longest,atrim=duration=${DURATION}[score]`,
  `${label(scoreParts, chains.length)}amix=inputs=${chains.length - scoreParts}:normalize=0:duration=longest,apad,atrim=duration=${DURATION},asplit=3[cues][key][cueout]`,
  // The score ducks under every cue: a sidechain on the cues.
  `[score][key]sidechaincompress=threshold=0.03:ratio=5:attack=4:release=180:makeup=1[ducked]`,
  `[ducked]asplit=2[duckmix][duckout]`,
  `[duckmix][cues]amix=inputs=2:normalize=0,alimiter=limit=0.95:attack=2:release=40[mix]`,
];
const args = inputs.flatMap((file) => ["-i", file]);
ffmpeg([...args, "-filter_complex", graph.join(";"), "-map", "[mix]", "-ar", "48000", join(out, "premix.wav"), "-map", "[duckout]", "-ar", "48000", join(out, "music.wav"), "-map", "[cueout]", "-ar", "48000", join(out, "cues.wav")]);

// -14 LUFS integrated, true peak under -1 dBTP: loudnorm measured, then applied linearly.
const report = spawnSync("ffmpeg", ["-hide_banner", "-i", join(out, "premix.wav"), "-af", "loudnorm=I=-14:TP=-1:LRA=11:print_format=json", "-f", "null", "-"], { encoding: "utf8" }).stderr;
const stats = JSON.parse(report.match(/\{[^{}]*\}/g).at(-1));
ffmpeg(["-i", join(out, "premix.wav"), "-af", `loudnorm=I=-14:TP=-1:LRA=11:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}:offset=${stats.target_offset}:linear=true`, "-ar", "48000", join(out, "mix.wav")]);

writeFileSync(join(out, "cues.json"), JSON.stringify({ intro: { bpm: intro.bpm, first: intro.first }, drop: { bpm: drop.bpm, first: drop.first }, riserStop, cues: placed.map(({ at, sound, attack }) => ({ at, sound, attack })) }, null, 1));
const picture = join(out, "picture.mp4");
if (existsSync(picture)) {
  const film = join(here, "out", `ghostly-v1.0-${format}.mp4`);
  ffmpeg(["-i", picture, "-i", join(out, "mix.wav"), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "320k", "-movflags", "+faststart", "-shortest", film]);
  console.log("✓", film);
} else console.log("✓", join(out, "mix.wav"), "(no picture yet: render.mjs first)");

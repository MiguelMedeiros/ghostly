// The soundtrack: the narration on its lines, the score's parts placed on the story's turns, the sounds the picture
// asks for (out/<format>/sounds.json, written by render.mjs), the score ducked under the voice, -14 LUFS; then the
// picture and the sound in one file.
//   node media/ghost-trailer/mix.mjs [--format 16x9]      → out/<format>/{mix,voice,score,fx}.wav and out/ghostly-trailer-<format>.mp4
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decode, RATE } from "../launch-video/beats.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const format = arg("format", "16x9");
const out = join(here, "out", format);
const { duration, lines } = JSON.parse(readFileSync(join(here, "out", "timeline.json"), "utf8"));
const sounds = JSON.parse(readFileSync(join(out, "sounds.json"), "utf8"));
const music = (name) => join(here, "cache", "music", `${name}.mp3`);
const app = (name) => join(here, "..", "..", "src", "assets", "sounds", `${name}.mp3`);
const ffmpeg = (args) => execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1 << 26 });
const at = (id, word) => { const l = lines.find((x) => x.id === id); return word ? l.words.find((w) => w.text.toLowerCase().replace(/[^a-z]/g, "") === word).start : l.start; };

/** Where a sound's attack is: the first moment it reaches a tenth of its peak. */
function attack(file) {
  const s = decode(file);
  let peak = 0;
  for (const v of s) peak = Math.max(peak, Math.abs(v));
  let i = 0;
  while (i < s.length && Math.abs(s[i]) < peak * 0.1) i++;
  return i / RATE;
}

const inputs = [], chains = { score: [], voice: [], fx: [] };
const input = (file) => inputs.push(file) - 1;
/** `seconds` of a file from `from`, placed at `place`, with fades and filters. */
function piece(bus, file, { from = 0, seconds, place, fadeIn = 0.02, fadeOut = 0.02, db = 0, filters = [] }) {
  const n = input(file);
  const trim = seconds ? [`atrim=start=${from.toFixed(3)}:duration=${seconds.toFixed(3)}`, "asetpts=PTS-STARTPTS"] : [];
  const fades = seconds ? [`afade=t=in:d=${fadeIn}`, `afade=t=out:st=${(seconds - fadeOut).toFixed(3)}:d=${fadeOut}`] : [];
  chains[bus].push(`[${n}:a]aformat=sample_rates=48000:channel_layouts=stereo,${[...trim, ...filters, ...fades, `volume=${db}dB`, `adelay=${Math.max(0, Math.round(place * 1000))}:all=1`].join(",")}`);
}

// The score. The cold open runs until "middlemen", where the tower falls in silence. The story's cue opens up
// (its first 16 s are a quiet intro) exactly when the crowd appears; the rise peaks on "the two of them"; the
// title's cue starts on its own hit, with the title.
const vast = at("crowd", "vast"), two = at("two"), title = at("title") - 0.7, sting = at("sting");
piece("score", music("cold"), { seconds: at("ghosts", "middlemen") + 0.35, place: 0, fadeIn: 1.2, fadeOut: 0.35 });
const storyFrom = at("boo") - 1.6;
// The story cue's quiet intro is lifted to sit under "This is Boo" and the invitation, then the body plays as it is.
const storyFile = vast - 16;
piece("score", music("story"), { from: storyFrom - storyFile, seconds: vast - storyFrom + 0.3, place: storyFrom, fadeIn: 1.2, fadeOut: 0.3, db: 14 });
piece("score", music("story"), { from: 16, seconds: 55 - vast, place: vast, fadeIn: 0.3, fadeOut: 1.4, db: 2 });
const riseAt = two - 7;
piece("score", music("rise"), { from: 0, seconds: title - riseAt, place: riseAt, fadeIn: 0.8, fadeOut: 0.08 });
piece("score", music("title"), { from: attack(music("title")), seconds: sting - 0.9 - title, place: title, fadeOut: 1.2 });
piece("score", music("wind"), { seconds: at("boo") + 2, place: 0, fadeIn: 1, fadeOut: 2, db: 26 });

// The narration: a little compression, the rumble below 80 Hz off.
for (const line of lines) piece("voice", join(here, "cache", "voice", `${line.id}.wav`), { place: line.start, filters: ["highpass=f=80", "acompressor=threshold=0.12:ratio=2.5:attack=6:release=120:makeup=1.3"] });

// The picture's sounds, each attack on its moment.
for (const s of sounds) {
  const file = s.sound.startsWith("app:") ? app(s.sound.slice(4)) : music(s.sound);
  piece("fx", file, { place: s.at - attack(file), db: s.db });
}

// The generated score is mastered loud and the narration is not: the score goes well under the voice (check.mjs
// measures the voice about 10 dB over it while it speaks), then ducks a little more under each line.
const SCORE_DB = Number(arg("score-db", -12)), VOICE_DB = Number(arg("voice-db", 5));
const labels = (bus) => chains[bus].map((_, i) => `[${bus}${i}]`).join("");
const graph = [
  ...Object.entries(chains).flatMap(([bus, list]) => list.map((c, i) => `${c}[${bus}${i}]`)),
  `${labels("score")}amix=inputs=${chains.score.length}:normalize=0:duration=longest,apad,atrim=duration=${duration},volume=${SCORE_DB}dB[score]`,
  `${labels("voice")}amix=inputs=${chains.voice.length}:normalize=0:duration=longest,apad,atrim=duration=${duration},volume=${VOICE_DB}dB,asplit=3[voice][key][voiceout]`,
  `${labels("fx")}amix=inputs=${chains.fx.length}:normalize=0:duration=longest,apad,atrim=duration=${duration},asplit=2[fx][fxout]`,
  // The score steps back while the narrator speaks.
  `[score][key]sidechaincompress=threshold=0.04:ratio=4:attack=20:release=350,asplit=2[ducked][scoreout]`,
  `[ducked][voice][fx]amix=inputs=3:normalize=0:weights=1 1 0.8,alimiter=limit=0.95:attack=3:release=60[mix]`,
];
ffmpeg([...inputs.flatMap((f) => ["-i", f]), "-filter_complex", graph.join(";"), "-map", "[mix]", "-ar", "48000", join(out, "premix.wav"),
  ...["voice", "score", "fx"].flatMap((stem) => ["-map", `[${stem}out]`, "-ar", "48000", join(out, `${stem}.wav`)])]);

// -14 LUFS integrated, true peak under -1 dBTP.
const report = spawnSync("ffmpeg", ["-hide_banner", "-i", join(out, "premix.wav"), "-af", "loudnorm=I=-14:TP=-1:LRA=11:print_format=json", "-f", "null", "-"], { encoding: "utf8" }).stderr;
const stats = JSON.parse(report.match(/\{[^{}]*\}/g).at(-1));
ffmpeg(["-i", join(out, "premix.wav"), "-af", `loudnorm=I=-14:TP=-1:LRA=11:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}:offset=${stats.target_offset}:linear=true,alimiter=limit=0.85:attack=2:release=50:level=false`, "-ar", "48000", join(out, "mix.wav")]);
const picture = join(out, "picture.mp4");
if (existsSync(picture)) {
  const film = join(here, "out", `ghostly-trailer-${format}.mp4`);
  ffmpeg(["-i", picture, "-i", join(out, "mix.wav"), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "320k", "-movflags", "+faststart", "-shortest", film]);
  console.log("✓", film);
} else console.log("✓", join(out, "mix.wav"), "(no picture yet: render.mjs first)");

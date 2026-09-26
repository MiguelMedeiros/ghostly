// The narration, one line at a time, with ElevenLabs' character timestamps so the captions and the picture can land
// on the words. Each line is cached in cache/voice/ by the hash of what was asked: a rerun bills only changed lines.
//   ELEVENLABS_API_KEY=... node media/ghost-trailer/voice.mjs      → cache/voice/<id>.wav + cache/voice/voice.json
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "cache", "voice");
mkdirSync(out, { recursive: true });
const { voice, lines } = JSON.parse(readFileSync(join(here, "script.json"), "utf8"));
/** Extra silence at each | of a line, unless the line gives its own `pauses`. */
const PAUSE = 0.45;
const spoken = (line) => line.say.split("|").map((part) => part.trim()).join(" ");

const meta = {};
for (const [index, line] of lines.entries()) {
  const text = spoken(line);
  const settings = { ...voice.settings, ...line.settings };
  const request = { text, model_id: voice.model, voice_settings: settings, previous_text: lines[index - 1] && spoken(lines[index - 1]), next_text: lines[index + 1] && spoken(lines[index + 1]) };
  const cache = join(out, `${line.id}.${createHash("sha1").update(JSON.stringify([voice.id, request])).digest("hex").slice(0, 10)}.json`);
  if (!existsSync(cache)) {
    if (!process.env.ELEVENLABS_API_KEY) throw new Error("ELEVENLABS_API_KEY is not set (see README.md)");
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice.id}/with-timestamps?output_format=mp3_44100_192`, {
      method: "POST", headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "content-type": "application/json" }, body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error(`${line.id}: ${response.status} ${await response.text()}`);
    writeFileSync(cache, await response.text());
    console.log("generated", line.id);
  }
  const { audio_base64, alignment } = JSON.parse(readFileSync(cache, "utf8"));
  const mp3 = join(out, `${line.id}.mp3`);
  writeFileSync(mp3, Buffer.from(audio_base64, "base64"));
  // The line runs from just before its first sound to a breath after its last word, and each | in `say` opens a
  // pause: the audio is cut in the quiet between the two phrases and silence goes in (trailer pacing).
  const starts = alignment.character_start_times_seconds, ends = alignment.character_end_times_seconds;
  const chars = alignment.characters;
  const lastWord = chars.findLastIndex((c) => /[\p{L}\p{N}]/u.test(c));
  const from = Math.max(0, starts[0] - 0.03), to = ends[lastWord] + 0.35;
  const cuts = [];
  let offset = 0;
  const phrases = line.say.split("|").map((part) => part.trim());
  phrases.slice(0, -1).forEach((phrase, k) => {
    offset += phrase.length;
    const before = chars.slice(0, offset).findLastIndex((c) => /[\p{L}\p{N}]/u.test(c));
    const after = offset + chars.slice(offset).findIndex((c) => /[\p{L}\p{N}]/u.test(c));
    cuts.push({ at: (ends[before] + starts[after]) / 2, add: line.pauses?.[k] ?? PAUSE });
    offset += 1;
  });
  // A time in the generated audio, moved by the pauses before it, relative to the line's start.
  const shift = (t) => +(t - from + cuts.filter((c) => c.at < t).reduce((sum, c) => sum + c.add, 0)).toFixed(3);
  const duration = shift(to);
  const edges = [from, ...cuts.map((c) => c.at), to];
  const graph = [];
  edges.slice(0, -1).forEach((a, i) => {
    const b = edges[i + 1];
    graph.push(`[0:a]atrim=start=${a.toFixed(3)}:end=${b.toFixed(3)},asetpts=N/SR/TB,aformat=sample_rates=48000:channel_layouts=stereo,afade=t=in:d=0.01,afade=t=out:st=${(b - a - 0.02).toFixed(3)}:d=0.02[s${i}]`);
    if (cuts[i]) graph.push(`anullsrc=r=48000:cl=stereo,atrim=end=${cuts[i].add.toFixed(3)}[z${i}]`);
  });
  const parts = edges.slice(0, -1).flatMap((_, i) => cuts[i] ? [`[s${i}]`, `[z${i}]`] : [`[s${i}]`]);
  graph.push(`${parts.join("")}concat=n=${parts.length}:v=0:a=1,afade=t=out:st=${(duration - 0.15).toFixed(3)}:d=0.15[out]`);
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", mp3, "-filter_complex", graph.join(";"), "-map", "[out]", "-ar", "48000", join(out, `${line.id}.wav`)]);
  // Words with their times, relative to the line's start, in the order spoken; `phrase` is the caption chunk.
  const words = [];
  let current = null, phrase = 0, seen = 0;
  const bounds = phrases.map((p) => (seen += p.length + 1));
  chars.forEach((c, i) => {
    while (i >= bounds[phrase]) phrase++;
    if (/\s/.test(c)) { current = null; return; }
    if (!current) { current = { text: "", start: shift(starts[i]), phrase }; words.push(current); }
    current.text += c;
    current.end = shift(ends[i]);
  });
  meta[line.id] = { duration, words };
  console.log(line.id.padEnd(8), duration.toFixed(2).padStart(6), "s", `${(words.length / duration).toFixed(2)} words/s`);
}
writeFileSync(join(out, "voice.json"), JSON.stringify(meta, null, 1));

// The score, one ElevenLabs cue per act of out/timeline.json, and the few sound effects that are not the app's own.
// Cached in cache/music/ by the hash of what was asked, so a rerun bills nothing unless a prompt or an act's length
// changed. Long cues fade in and out on their own: each asks for extra seconds and mix.mjs uses its body.
//   ELEVENLABS_API_KEY=... node media/ghost-trailer/music.mjs [names…]
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "cache", "music");
mkdirSync(out, { recursive: true });
const { acts } = JSON.parse(readFileSync(join(here, "out", "timeline.json"), "utf8"));
const headers = { "xi-api-key": process.env.ELEVENLABS_API_KEY ?? "", "content-type": "application/json" };

const STYLE = "A minor, cinematic ghost story trailer score, magical and a little spooky, warm not horror, instrumental, leaves room for a narrator";
// [prompt, extra seconds to ask for]
const CUES = {
  cold: ["Dark eerie cold open: a lonely detuned music box melody over a low ominous drone, distant wind, a slow sub pulse like a heartbeat, sparse and unsettling, no drums. " + STYLE, 8],
  story: ["Curious, playful and mysterious adventure underscore: soft pizzicato strings and celesta, gentle ticking pulses like little signals travelling through a dark network, a slow steady build, magical and warm, light percussion only. " + STYLE, 10],
  rise: ["Emotional uplifting swell: warm strings and airy synth pads rising, hopeful, two friends finally meet, building to a crescendo, soft cinematic drums enter halfway. " + STYLE, 8],
  title: ["Starts instantly with one big warm cinematic hit, then a shimmering hopeful pad with a faint music box motif, resolving gently, no drums after the hit. " + STYLE, 4],
};
const SFX = {
  crumble: ["A tall stone tower crumbling into glittering dust, an eerie airy magical whoosh as it dissolves", 3],
  whoosh: ["A soft magical airy whoosh of a small glowing card flying past, sparkle at the end", 1.2],
  wind: ["Dark night ambience, soft distant wind and a faint ghostly air, calm, no voices, no music", 22],
  blip: ["One tiny soft digital blip, a single short sonar tick, clean", 0.5],
  hit: ["Big warm cinematic impact with a deep boom and a shimmering reverse cymbal tail", 3],
  pluck: ["A playful spooky cartoon pluck, one pizzicato note with a tiny swoosh", 1],
};

async function cached(name, body, url) {
  const file = join(out, `${name}.${createHash("sha1").update(JSON.stringify([url, body])).digest("hex").slice(0, 10)}.mp3`);
  if (!existsSync(file)) {
    if (!process.env.ELEVENLABS_API_KEY) throw new Error("ELEVENLABS_API_KEY is not set (see README.md)");
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`${name}: ${response.status} ${await response.text()}`);
    writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    console.log("generated", name);
  }
  copyFileSync(file, join(out, `${name}.mp3`));
}

const only = process.argv.slice(2);
const wanted = (name) => !only.length || only.includes(name);
for (const [name, [text, duration_seconds]] of Object.entries(SFX))
  if (wanted(name)) await cached(name, { text, duration_seconds, prompt_influence: 0.5 }, "https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_192");
for (const act of acts) {
  if (!CUES[act.id] || !wanted(act.id)) continue;
  const [prompt, extra] = CUES[act.id];
  // Lengths are rounded up to whole seconds, so a small change in the narration reuses the cached cue.
  const seconds = Math.max(10, Math.ceil(act.to - act.from + extra));
  await cached(act.id, { prompt, music_length_ms: seconds * 1000, force_instrumental: true, model_id: "music_v1" }, "https://api.elevenlabs.io/v1/music?output_format=mp3_44100_192");
}

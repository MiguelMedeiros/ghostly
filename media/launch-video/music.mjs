// The score and the few sounds that are not the app's own, from ElevenLabs. Every generation is cached in
// cache/ by the hash of what was asked, so running this again bills nothing unless a prompt changed.
//   ELEVENLABS_API_KEY=... node media/launch-video/music.mjs            → cache/music/<name>.mp3
//
// One cue per part: a single long generation drifts away from the section lengths it is asked for. Long cues
// fade in and out on their own, so each asks for extra seconds and mix.mjs uses only its body. The tempo is
// asked for and then measured (beats.mjs): the mix stretches each part onto the exact grid.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BAR } from "./timeline.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "cache", "music");
mkdirSync(out, { recursive: true });
const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error("ELEVENLABS_API_KEY is not set (see README.md)");
const headers = { "xi-api-key": key, "content-type": "application/json" };

const STYLE = "128 BPM, A minor, 4/4, upbeat modern electronic, melodic future house, punchy and bright, catchy, a viral tech product launch video, instrumental";
// [prompt, bars the part fills, extra seconds to ask for]
export const PARTS = {
  intro: ["Starts instantly on the very first beat at full level, no fade in: a catchy bouncy plucked synth hook with a punchy kick on every beat, tight hi-hats and claps, playful and energetic, the hook repeats every two bars. " + STYLE, 7, 8],
  drop: ["Starts instantly with a huge euphoric drop at full energy, no intro and no fade in: wide sidechained supersaw chords, a punchy four on the floor kick, a driving rolling bassline, a catchy lead melody, claps on two and four, keeps the full energy the whole time. " + STYLE, 16, 10],
  final: ["Starts instantly with one massive final hit: a huge supersaw chord stab with a deep kick and a crash cymbal, then the chord rings out and decays to silence, no drums after the hit, nothing else. " + STYLE, 1, 8],
};
const SFX = {
  riser: ["Energetic EDM white noise riser with a snare roll speeding up, building tension for exactly four seconds then stopping dead at the peak", 4],
  impact: ["Punchy EDM drop impact, a deep sub boom with a bright crash cymbal, short tail", 2],
  downlift: ["Short EDM downlifter, filtered white noise sweeping down, airy", 2],
};

async function cached(name, body, url) {
  const file = join(out, `${name}.${createHash("sha1").update(JSON.stringify([url, body])).digest("hex").slice(0, 10)}.mp3`);
  if (!existsSync(file)) {
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
for (const [name, [prompt, bars, extra]] of Object.entries(PARTS))
  if (wanted(name))
    await cached(name, { prompt, music_length_ms: Math.max(10_000, Math.round((bars * BAR + extra) * 1000)), force_instrumental: true, model_id: "music_v1" },
      "https://api.elevenlabs.io/v1/music?output_format=mp3_44100_192");

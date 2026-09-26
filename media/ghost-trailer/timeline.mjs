// Lays the narration out on the film's clock: each line after its gap, with every word's time, the caption chunks
// and where each music part starts. The picture (film/), the mix and the report all read out/timeline.json.
//   node media/ghost-trailer/timeline.mjs      → out/timeline.json
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { lines } = JSON.parse(readFileSync(join(here, "script.json"), "utf8"));
const voice = JSON.parse(readFileSync(join(here, "cache", "voice", "voice.json"), "utf8"));
/** The picture holds on the title and the sting after the last word. */
const TAIL = 1.4;

let clock = 0;
const laid = lines.map((line) => {
  const { duration, words } = voice[line.id];
  const start = +(clock + line.gap).toFixed(3);
  clock = start + duration;
  const shows = line.show.split("|").map((part) => part.trim());
  const placed = words.map((w) => ({ ...w, start: +(start + w.start).toFixed(3), end: +(start + w.end).toFixed(3) }));
  const phrases = shows.map((text, k) => {
    const own = placed.filter((w) => w.phrase === k);
    return { text, start: own[0].start, end: own.at(-1).end };
  });
  return { id: line.id, act: line.act, scene: line.scene, start, end: +clock.toFixed(3), words: placed, phrases };
});
const duration = +(clock + TAIL).toFixed(2);
// A music part starts with the gap before its first line, so the score turns before the voice does.
const acts = [];
for (const line of laid) {
  const gap = lines.find((l) => l.id === line.id).gap;
  if (acts.at(-1)?.id !== line.act) acts.push({ id: line.act, from: acts.length ? +(line.start - gap).toFixed(3) : 0 });
}
acts.forEach((act, i) => { act.to = acts[i + 1]?.from ?? duration; });

mkdirSync(join(here, "out"), { recursive: true });
writeFileSync(join(here, "out", "timeline.json"), JSON.stringify({ duration, acts, lines: laid }, null, 1));
for (const line of laid) console.log(line.id.padEnd(8), line.start.toFixed(2).padStart(6), "→", line.end.toFixed(2).padStart(6), line.scene);
console.log("acts", acts.map((a) => `${a.id} ${a.from.toFixed(1)}-${a.to.toFixed(1)}`).join(", "), "| duration", duration);

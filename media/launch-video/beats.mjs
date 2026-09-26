// Measures a music file's beat grid, since nobody here can listen: its tempo, where its beats fall, which of
// them start bars, and how loud each bar is (a cue fades in and out on its own; the mix keeps its body).
//   node media/launch-video/beats.mjs <file.mp3> [--bpm 128]     → JSON on stdout
// Also imported by mix.mjs (grid) and check.mjs (onsets).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const RATE = 22050;
const HOP = 256, WIN = 1024;

/** The file as mono floats at RATE. */
export function decode(file, rate = RATE) {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", String(rate), "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k], j = i + k + len / 2;
        const vr = re[j] * cr - im[j] * ci, vi = re[j] * ci + im[j] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi; re[j] = ur - vr; im[j] = ui - vi;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}

/**
 * The onset strength every HOP samples: the rise of the log spectrum (spectral flux), whole band and low band
 * (the kick) apart. Returns { flux, low, rate } with rate the envelope's frames per second.
 */
export function onsetEnvelope(samples, rate = RATE) {
  const frames = Math.max(0, Math.floor((samples.length - WIN) / HOP));
  const flux = new Float32Array(frames), low = new Float32Array(frames);
  const hann = Float32Array.from({ length: WIN }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN));
  const lowBin = Math.round((150 / rate) * WIN);
  let prev = new Float32Array(WIN / 2);
  const re = new Float32Array(WIN), im = new Float32Array(WIN);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < WIN; i++) { re[i] = samples[f * HOP + i] * hann[i]; im[i] = 0; }
    fft(re, im);
    const mag = new Float32Array(WIN / 2);
    let sum = 0, sumLow = 0;
    for (let k = 1; k < WIN / 2; k++) {
      mag[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
      const rise = Math.max(0, mag[k] - prev[k]);
      sum += rise;
      if (k <= lowBin) sumLow += rise;
    }
    flux[f] = sum; low[f] = sumLow; prev = mag;
  }
  return { flux, low, rate: rate / HOP };
}

const valueAt = (env, x) => { const i = Math.floor(x), f = x - i; return i < 0 || i + 1 >= env.length ? 0 : env[i] * (1 - f) + env[i + 1] * f; };

/**
 * The grid: the tempo (searched near `bpm` when given, else 100-160) and the beat phase that best fit the
 * onsets, then each beat nudged to its local onset peak (within 30 ms) to see how steady it really is.
 */
export function grid(samples, { bpm: near, from = 0, to = Infinity } = {}) {
  const { flux, low, rate } = onsetEnvelope(samples);
  const env = flux.map((v, i) => v + 2 * low[i]);
  const a = Math.floor(from * rate), b = Math.min(env.length, Math.floor(to * rate));
  const [lo, hi, step] = near ? [near - 4, near + 4, 0.01] : [100, 160, 0.05];
  let best = { score: -1 };
  for (let bpm = lo; bpm <= hi; bpm += step) {
    const period = (60 / bpm) * rate;
    for (let phase = 0; phase < period; phase += 0.5) {
      let score = 0, n = 0;
      for (let x = a + phase; x < b; x += period) { score += valueAt(env, x); n++; }
      score /= n;
      if (score > best.score) best = { score, bpm, phase: (a + phase) / rate };
    }
  }
  const beat = 60 / best.bpm;
  let first = best.phase;
  while (first - beat >= 0) first -= beat;
  const beats = [];
  for (let t = first; t * rate < env.length - 2; t += beat) {
    // the strongest onset within 30 ms of the grid, for the drift report
    let peak = t, top = -1;
    for (let d = -0.03; d <= 0.03; d += 1 / rate) { const v = valueAt(env, (t + d) * rate); if (v > top) { top = v; peak = t + d; } }
    beats.push({ t: Number(t.toFixed(4)), onset: Number(peak.toFixed(4)), strength: Number(top.toFixed(2)), low: Number(valueAt(low, peak * rate).toFixed(2)) });
  }
  // Which beat of four starts a bar: the one with the most low-band rise (the kick plus the bass change) on average.
  const bySlot = [0, 1, 2, 3].map((s) => beats.filter((_, i) => i % 4 === s).reduce((sum, x) => sum + x.low + x.strength, 0));
  const downbeat = bySlot.indexOf(Math.max(...bySlot));
  return { bpm: Number(best.bpm.toFixed(2)), first, beat, downbeat, beats };
}

/** Loudness (RMS dBFS) per window of `seconds`. */
export function levels(samples, seconds, start = 0, rate = RATE) {
  const out = [];
  for (let t = start; (t + seconds) * rate <= samples.length; t += seconds) {
    let sum = 0;
    const a = Math.round(t * rate), b = Math.round((t + seconds) * rate);
    for (let i = a; i < b; i++) sum += samples[i] * samples[i];
    out.push(Number((10 * Math.log10(sum / (b - a) + 1e-12)).toFixed(1)));
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  const bpmAt = process.argv.indexOf("--bpm");
  const samples = decode(file);
  const g = grid(samples, { bpm: bpmAt > 0 ? Number(process.argv[bpmAt + 1]) : undefined });
  const bar0 = g.first + g.downbeat * g.beat;
  const drift = g.beats.map((x) => (x.onset - x.t) * 1000);
  const steady = drift.filter((d) => Math.abs(d) <= 8).length / drift.length;
  console.log(JSON.stringify({
    file, seconds: Number((samples.length / RATE).toFixed(2)), bpm: g.bpm, firstBeat: Number(g.first.toFixed(4)), firstBar: Number(bar0.toFixed(4)),
    onGrid: `${Math.round(steady * 100)}% of beats within 8 ms`,
    barLevels: levels(samples, 4 * g.beat, bar0),
  }, null, 1));
}

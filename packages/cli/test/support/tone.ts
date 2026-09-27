/** Test tones as the call contract carries them: s16le mono PCM. */
export function tone(hz: number, rate: number, ms: number, amplitude = 0.3, startSample = 0): Buffer {
  const samples = Math.round((rate * ms) / 1000);
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) out.writeInt16LE(Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * hz * (startSample + i)) / rate)), i * 2);
  return out;
}

/** The loudest frequency in `pcm` between `from` and `to` Hz (a plain DFT scan; fine for a second of audio). */
export function dominantHz(pcm: Buffer, rate: number, from = 100, to = 2000, step = 5): number {
  const n = Math.floor(pcm.length / 2);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = pcm.readInt16LE(i * 2);
  let best = 0, bestHz = 0;
  for (let hz = from; hz <= to; hz += step) {
    let re = 0, im = 0;
    const w = (2 * Math.PI * hz) / rate;
    for (let i = 0; i < n; i++) { re += x[i] * Math.cos(w * i); im -= x[i] * Math.sin(w * i); }
    const power = re * re + im * im;
    if (power > best) { best = power; bestHz = hz; }
  }
  return bestHz;
}

/** Root mean square of `pcm`, 0..1. */
export function level(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2) / 32768; sum += v * v; }
  return Math.sqrt(sum / n);
}

/** A 16-bit mono PCM WAV file around `pcm`. */
export function wavFile(pcm: Buffer, rate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii"); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii"); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii"); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

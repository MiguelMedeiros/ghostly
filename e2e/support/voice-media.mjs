import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Voice messages across engines: every Ghostly records with its own engine's MediaRecorder and plays with
 * another's `<audio>`, under its own Content-Security-Policy. These run inside a page — a Playwright page,
 * the Tauri WebView through WebDriver, the macOS system WKWebView (`scripts/voice-media/`) — so they are
 * written as plain functions that are sent as source (`String(fn)`) and use nothing from outside.
 */

/** The committed recordings, one per engine and type: `e2e/support/voice-fixtures/<engine>.<ext>`. */
export const FIXTURES_DIR = join(import.meta.dirname, "voice-fixtures");

const TYPES = { webm: "audio/webm", m4a: "audio/mp4", ogg: "audio/ogg" };

/** `[{ name, mime, base64 }]` for every committed recording. */
export function loadFixtures() {
  return readdirSync(FIXTURES_DIR)
    .filter((name) => /\.(webm|m4a|ogg)$/.test(name))
    .sort()
    .map((name) => ({ name, mime: TYPES[name.split(".").pop()], base64: readFileSync(join(FIXTURES_DIR, name)).toString("base64") }));
}

/**
 * In the page: records `ms` of a tone that rises and falls like speech, from an oscillator (no microphone),
 * in each of `types` this engine can record, as the app does it (32 kbit/s, a chunk a second).
 * Resolves `{ [type]: base64 | null }`.
 */
export async function recordInPage(types, ms) {
  const out = {};
  for (const type of types) {
    if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported(type)) { out[type] = null; continue; }
    const context = new AudioContext();
    const tone = context.createOscillator();
    const level = context.createGain();
    const sink = context.createMediaStreamDestination();
    tone.frequency.value = 220;
    level.gain.setValueAtTime(0.05, context.currentTime);
    for (let at = 0; at < ms / 1000; at += 0.25) level.gain.linearRampToValueAtTime(at % 0.5 === 0 ? 0.6 : 0.1, context.currentTime + at);
    tone.connect(level).connect(sink);
    tone.start();
    await context.resume();
    const recorder = new MediaRecorder(sink.stream, { mimeType: type, audioBitsPerSecond: 32_000 });
    const chunks = [];
    recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
    recorder.start(1000);
    await new Promise((resolve) => setTimeout(resolve, ms));
    recorder.stop();
    await stopped;
    tone.stop();
    await context.close();
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    out[type] = btoa(binary);
  }
  return out;
}

/**
 * In the page: plays each fixture muted from a `blob:` URL, as the voice bubble does, and reports what
 * happened: `{ [name]: { canPlay, played, error? } }`. `played` means the clock moved past 0.3 s (or the
 * recording ended), which only happens when the engine really demuxed and decoded it.
 */
export async function playInPage(fixtures) {
  const out = {};
  for (const { name, mime, base64 } of fixtures) {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const audio = new Audio();
    audio.muted = true;
    const canPlay = audio.canPlayType(mime);
    audio.src = url;
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ played: false, error: `stuck at ${audio.currentTime.toFixed(2)} s` }), 8_000);
      const finish = (value) => { clearTimeout(timer); resolve(value); };
      audio.addEventListener("error", () => finish({ played: false, error: `MediaError ${audio.error?.code} ${audio.error?.message ?? ""}`.trim() }));
      audio.addEventListener("timeupdate", () => { if (audio.currentTime > 0.3) finish({ played: true }); });
      audio.addEventListener("ended", () => finish({ played: true }));
      audio.play().catch((error) => finish({ played: false, error: `play() ${error?.name}: ${error?.message}` }));
    });
    audio.pause();
    audio.removeAttribute("src");
    URL.revokeObjectURL(url);
    out[name] = { canPlay, ...result };
  }
  return out;
}

/**
 * In the page: plays each fixture muted at `rate` (2× by default) with the pitch kept, as the voice bubble's speed pill does,
 * and reports what the engine made of it: `{ [name]: { rate, preservesPitch, speed, speeds, pooled, error? } }`. `rate` and
 * `preservesPitch` are read back from the element (an engine without them reports 1 and undefined); `speed` is
 * how many seconds of the recording played per second of wall clock, so 2 means it really plays twice as fast.
 * The clock is read every 10 ms and a line is fitted through the moments it moved: `timeupdate` arrives up to
 * 250 ms late, and WebKit moves a WebM clock in half-second steps, so two readings alone can be far off either
 * way. The last move is left out, since the clock jumps to the end before the play has caught up. The recording
 * is played `attempts` times: `speeds` times each play, `pooled` fits all of them together, and `speed` is the
 * fastest of those, since a busy machine can stall the audio and slow a play but never speed it up.
 */
export async function rateInPage(fixtures, rate = 2, { attempts = 3 } = {}) {
  const once = (url) => new Promise((resolve) => {
    const audio = new Audio();
    audio.muted = true;
    audio.preservesPitch = true;
    audio.webkitPreservesPitch = true;
    audio.src = url;
    audio.defaultPlaybackRate = rate;
    audio.playbackRate = rate;
    const moves = [];
    const poll = setInterval(() => {
      const time = audio.currentTime;
      if (time > 0 && (!moves.length || time > moves[moves.length - 1].time)) moves.push({ at: performance.now(), time });
    }, 10);
    const timer = setTimeout(() => finish({ error: `stuck at ${audio.currentTime.toFixed(2)} s` }), 8_000);
    const finish = (value) => {
      clearInterval(poll);
      clearTimeout(timer);
      // Read from the engine's own property: on an engine without one, the value set above is only a plain field.
      const pitch = "preservesPitch" in HTMLMediaElement.prototype ? audio.preservesPitch : "webkitPreservesPitch" in HTMLMediaElement.prototype ? audio.webkitPreservesPitch : undefined;
      const read = { rate: audio.playbackRate, preservesPitch: pitch };
      audio.pause();
      audio.removeAttribute("src");
      resolve({ ...read, ...value });
    };
    audio.addEventListener("error", () => finish({ error: `MediaError ${audio.error?.code} ${audio.error?.message ?? ""}`.trim() }));
    audio.addEventListener("ended", () => finish({ points: moves.slice(0, -1) }));
    audio.play().catch((error) => finish({ error: `play() ${error?.name}: ${error?.message}` }));
  });
  // The least-squares slope of media time over wall time, each play with its own start: one play of a short
  // recording moves a WebM clock only two or three times, so the plays are pooled as well as timed one by one.
  const slope = (plays) => {
    let sxy = 0;
    let sxx = 0;
    for (const points of plays) {
      const mx = points.reduce((sum, p) => sum + p.at, 0) / points.length;
      const my = points.reduce((sum, p) => sum + p.time, 0) / points.length;
      for (const p of points) { sxy += (p.at - mx) * (p.time - my); sxx += (p.at - mx) ** 2; }
    }
    return sxx > 0 ? Math.round((sxy / sxx) * 1000 * 100) / 100 : undefined;
  };
  const out = {};
  for (const { name, mime, base64 } of fixtures) {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const plays = [];
    let last;
    for (let i = 0; i < attempts; i++) {
      last = await once(url);
      // A recording that cannot play will not play the next time either.
      if (!last.points) break;
      plays.push(last.points);
    }
    URL.revokeObjectURL(url);
    const { points, error, ...read } = last;
    const speeds = plays.map((p) => (p.length >= 3 && p[p.length - 1].at - p[0].at >= 300 ? slope([p]) : null));
    const moved = plays.filter((p) => p.length >= 2);
    const pooled = moved.reduce((sum, p) => sum + p.length, 0) >= 4 ? slope(moved) : null;
    const timed = [...speeds, pooled].filter((v) => v != null);
    out[name] = timed.length ? { ...read, speed: Math.max(...timed), speeds, pooled }
      : { ...read, error: error ?? `too short to time (${plays.map((p) => p.length).join("+")} clock moves)`, speeds, pooled };
  }
  return out;
}

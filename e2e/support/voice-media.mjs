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

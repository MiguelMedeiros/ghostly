import { useEffect, useRef } from "react";
import { voiceLevel } from "@ghostly/core";
import type { LevelSource } from "../lib/voiceLevels";

/** From this level on, a side is speaking; a breath or a fan stays under it. */
const SPEAKING = 0.06;
/** The mark stays this long after the last loud moment, so it does not blink between words. */
const HOLD_MS = 400;

/** Reads `stream`'s loudness with an analyser: what gives the level now, and what closes it. None without sound, or in an engine with no analyser. */
function analysed(stream: MediaStream | null): { read: () => number; stop: () => void } | null {
  if (!stream || stream.getAudioTracks().length === 0) return null;
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  let context: AudioContext | null = null;
  try {
    context = new Context();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    if (context.state === "suspended") void context.resume().catch(() => {});
    const samples = new Float32Array(analyser.fftSize);
    const made = context;
    return {
      read: () => {
        analyser.getFloatTimeDomainData(samples);
        return voiceLevel(samples);
      },
      stop: () => void made.close().catch(() => {}),
    };
  } catch {
    // No analyser in this engine: the call goes on, with no mark.
    void context?.close().catch(() => {});
    return null;
  }
}

/**
 * Who is speaking in a call: while `on`, the element holding the returned ref says `data-speaking` and carries
 * `--voice-level` (0 to 1), read every 80 ms from an analyser on `stream`'s sound. The sound is only measured,
 * here on this device: nothing of it is played or sent. Where the page cannot hear the call (a Linux Desktop call
 * keeps its sound in Rust), `source` says the level instead; with neither, nothing is marked.
 */
export function useVoiceRing<T extends HTMLElement>(stream: MediaStream | null, on: boolean, source?: LevelSource) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!on || !el) return;
    let told = 0;
    const meter = source ? { read: () => told, stop: source((level) => { told = level; }) } : analysed(stream);
    if (!meter) return;
    let heardAt = -Infinity;
    const timer = setInterval(() => {
      const level = meter.read();
      if (level >= SPEAKING) heardAt = Date.now();
      const speaking = Date.now() - heardAt < HOLD_MS;
      el.dataset.speaking = String(speaking);
      el.style.setProperty("--voice-level", speaking ? level.toFixed(2) : "0");
    }, 80);
    return () => {
      clearInterval(timer);
      meter.stop();
      delete el.dataset.speaking;
      el.style.removeProperty("--voice-level");
    };
  }, [stream, on, source]);
  return ref;
}

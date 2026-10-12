import { useEffect, useRef } from "react";
import { voiceLevel } from "@ghostly/core";

/** From this level on, a side is speaking; a breath or a fan stays under it. */
const SPEAKING = 0.06;
/** The mark stays this long after the last loud moment, so it does not blink between words. */
const HOLD_MS = 400;

/**
 * Who is speaking in a call: while `on`, the element holding the returned ref says `data-speaking` and carries
 * `--voice-level` (0 to 1), read every 80 ms from an analyser on `stream`'s sound. The sound is only measured,
 * here on this device: nothing of it is played or sent. A stream with no sound (a Linux Desktop call keeps its
 * sound in Rust) marks nothing.
 */
export function useVoiceRing<T extends HTMLElement>(stream: MediaStream | null, on: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!on || !el || !stream || stream.getAudioTracks().length === 0) return;
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    let context: AudioContext | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      context = new Context();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      if (context.state === "suspended") void context.resume().catch(() => {});
      const samples = new Float32Array(analyser.fftSize);
      let heardAt = -Infinity;
      timer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        const level = voiceLevel(samples);
        if (level >= SPEAKING) heardAt = Date.now();
        const speaking = Date.now() - heardAt < HOLD_MS;
        el.dataset.speaking = String(speaking);
        el.style.setProperty("--voice-level", speaking ? level.toFixed(2) : "0");
      }, 80);
    } catch {
      // No analyser in this engine: the call goes on, with no mark.
    }
    return () => {
      clearInterval(timer);
      delete el.dataset.speaking;
      el.style.removeProperty("--voice-level");
      void context?.close().catch(() => {});
    };
  }, [stream, on]);
  return ref;
}

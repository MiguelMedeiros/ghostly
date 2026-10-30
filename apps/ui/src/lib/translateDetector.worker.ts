import { detectMultiple } from "@qvac/langdetect-text";

/*
 * The language detector, off the page (translateDetector.ts): evaluating its dictionary takes about half a second.
 * What it says is no answer when it throws: no guess, so the message is shown as it was sent.
 */
self.onmessage = ({ data: { id, text } }: MessageEvent<{ id: number; text: string }>) => {
  let guesses: ReturnType<typeof detectMultiple> = [];
  try { guesses = detectMultiple(text); } catch { /* no guess */ }
  self.postMessage({ id, guesses });
};

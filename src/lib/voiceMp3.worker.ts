import { encodeMp3 } from "./mp3Encode";

/** Encodes a voice message's samples to MP3 away from the page, so a long one never freezes the app. */
self.onmessage = (event: MessageEvent<{ samples: Float32Array; sampleRate: number }>) => {
  try {
    const bytes = encodeMp3(event.data.samples, event.data.sampleRate);
    self.postMessage({ bytes }, { transfer: [bytes.buffer] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};

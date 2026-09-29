import { MP3_SAMPLE_RATE } from "./mp3Encode";
import { decodeToMono } from "./voiceDecode";

/**
 * A voice message converted to MP3, here, when asked: Web Audio decodes it on the page (it has no decoder in a
 * worker), and a worker encodes it, so a fifteen-minute note does not hold the page for the seconds it takes.
 * Throws when this device cannot decode the recording.
 */
export async function voiceToMp3(recording: Blob): Promise<Blob> {
  const samples = await decodeToMono(recording, MP3_SAMPLE_RATE);
  if (!samples) throw new Error("This device cannot decode the recording");
  const worker = new Worker(new URL("./voiceMp3.worker.ts", import.meta.url), { type: "module" });
  try {
    const bytes = await new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<{ bytes?: Uint8Array<ArrayBuffer>; error?: string }>) =>
        event.data.bytes ? resolve(event.data.bytes) : reject(new Error(event.data.error ?? "Could not convert"));
      worker.onerror = (event) => reject(new Error(event.message || "Could not convert"));
      // Copied, not transferred: the samples belong to an AudioBuffer, whose memory not every engine lets go.
      worker.postMessage({ samples, sampleRate: MP3_SAMPLE_RATE });
    });
    return new Blob([bytes], { type: "audio/mpeg" });
  } finally {
    worker.terminate();
  }
}

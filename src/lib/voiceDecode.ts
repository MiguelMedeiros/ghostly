/**
 * A second way to play a voice message this device's `<audio>` refuses: Web Audio decodes it (its decoders
 * are not always the media element's), and the sound is handed back as WAV, which every engine plays and
 * seeks. Mono at 16 kHz is plenty for a voice and keeps the longest message (15 minutes) under 30 MB.
 */
const SAMPLE_RATE = 16_000;

type AudioContextClass = typeof AudioContext;
type OfflineAudioContextClass = typeof OfflineAudioContext;

function contexts(): { Live: AudioContextClass; Offline: OfflineAudioContextClass } | null {
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextClass;
    webkitAudioContext?: AudioContextClass;
    OfflineAudioContext?: OfflineAudioContextClass;
    webkitOfflineAudioContext?: OfflineAudioContextClass;
  };
  const Live = scope.AudioContext ?? scope.webkitAudioContext;
  const Offline = scope.OfflineAudioContext ?? scope.webkitOfflineAudioContext;
  return Live && Offline ? { Live, Offline } : null;
}

/** 16-bit PCM WAV of mono samples (-1…1). */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const data = samples.length * 2;
  const view = new DataView(new ArrayBuffer(44 + data));
  const text = (at: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
  text(0, "RIFF");
  view.setUint32(4, 36 + data, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // bytes per second
  view.setUint16(32, 2, true); // bytes per frame
  view.setUint16(34, 16, true); // bits per sample
  text(36, "data");
  view.setUint32(40, data, true);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([view.buffer], { type: "audio/wav" });
}

/** The recording as WAV, or null when Web Audio cannot decode it either. */
export async function decodeToWav(blob: Blob): Promise<Blob | null> {
  const classes = contexts();
  if (!classes) return null;
  let live: AudioContext | null = null;
  try {
    live = new classes.Live();
    const decoded = await live.decodeAudioData(await blob.arrayBuffer());
    // Resampled and mixed down to one channel by rendering it once, offline.
    const offline = new classes.Offline(1, Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE)), SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return encodeWav(rendered.getChannelData(0), SAMPLE_RATE);
  } catch {
    return null;
  } finally {
    void live?.close().catch(() => {});
  }
}

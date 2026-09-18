import { loadSettings } from "./settings";

/**
 * Every sound is synthesized: no audio files, nothing to download, and it
 * works the same in the desktop app, the extension and the web app.
 */
type Note = { frequency: number; at: number; duration: number; gain?: number; type?: OscillatorType };

const SOUNDS = {
  /** A message arrived. */
  message: [
    { frequency: 880, at: 0, duration: 0.09, gain: 0.13 },
    { frequency: 1046, at: 0.08, duration: 0.17, gain: 0.13 },
  ],
  /** Sats came in: two bright notes, like a coin. */
  coin: [
    { frequency: 1319, at: 0, duration: 0.09, gain: 0.16, type: "triangle" },
    { frequency: 1976, at: 0.08, duration: 0.42, gain: 0.16, type: "triangle" },
  ],
  /** Sats or a file went out. */
  sent: [
    { frequency: 523, at: 0, duration: 0.07, gain: 0.1 },
    { frequency: 784, at: 0.06, duration: 0.14, gain: 0.1 },
  ],
  /** The other side confirmed. */
  confirmed: [{ frequency: 1568, at: 0, duration: 0.22, gain: 0.08, type: "triangle" }],
  /** Someone asks for sats. */
  request: [
    { frequency: 659, at: 0, duration: 0.1, gain: 0.12 },
    { frequency: 659, at: 0.16, duration: 0.1, gain: 0.12 },
  ],
  /** One ring of an incoming call; looped by `startRinging`. */
  ring: [
    { frequency: 784, at: 0, duration: 0.35, gain: 0.14 },
    { frequency: 988, at: 0, duration: 0.35, gain: 0.1 },
    { frequency: 784, at: 0.5, duration: 0.35, gain: 0.14 },
    { frequency: 988, at: 0.5, duration: 0.35, gain: 0.1 },
  ],
  /** What the caller hears while it rings on the other side. */
  ringback: [{ frequency: 440, at: 0, duration: 0.9, gain: 0.05 }],
  hangup: [
    { frequency: 440, at: 0, duration: 0.12, gain: 0.1 },
    { frequency: 330, at: 0.12, duration: 0.2, gain: 0.1 },
  ],
} satisfies Record<string, Note[]>;

export type SoundName = keyof typeof SOUNDS;

let context: AudioContext | null = null;

function play(notes: Note[]): void {
  try {
    context ??= new AudioContext();
    // Browsers keep audio suspended until the user interacted with the page once.
    if (context.state === "suspended") void context.resume();
    const start = context.currentTime + 0.01;
    for (const note of notes) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = note.type ?? "sine";
      oscillator.frequency.setValueAtTime(note.frequency, start + note.at);
      gain.gain.setValueAtTime(0.0001, start + note.at);
      gain.gain.exponentialRampToValueAtTime(note.gain ?? 0.12, start + note.at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + note.at + note.duration);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start + note.at);
      oscillator.stop(start + note.at + note.duration + 0.02);
    }
  } catch {
    // no audio device, or audio not allowed yet
  }
}

export function playSound(name: SoundName): void {
  if (loadSettings().notifications.soundEnabled) play(SOUNDS[name]);
}

/** Rings until the returned function is called. */
export function startRinging(kind: "ring" | "ringback"): () => void {
  playSound(kind);
  const timer = setInterval(() => playSound(kind), kind === "ring" ? 2000 : 3000);
  return () => clearInterval(timer);
}

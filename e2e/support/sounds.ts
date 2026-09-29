import type { Peer } from "./fixtures";

/**
 * What a peer would hear, recorded instead of played (the recipe of chat-mute.spec.ts): a stand-in AudioContext
 * whose decoding fails, so the app plays each sound's synthesized fallback, and every note it starts is kept. A note
 * only one sound plays names that sound (src/lib/sounds.ts; the UI tests check each cue's notes are its own).
 */
export const NOTE = {
  message: 880,
  paid: 1244,
  testcoins: 2093,
  failed: 208,
  sealed: 349,
  shared: 1397,
  checked: 1760,
  knock: 392,
  mention: 1480,
  slide: 2960,
  flip: 2794,
  wallet: 2000,
  group: 466,
} as const;
/** The Interface category's cues: off unless turned on. */
export const INTERFACE_NOTES = [NOTE.slide, NOTE.flip, NOTE.wallet, NOTE.group];

/**
 * Records this peer's sounds from now on, with the app in front (`focused`, the default) or in the background. The page
 * reloads to take the stand-in, and a key press unlocks audio, as a person's first gesture does.
 */
export async function listen(peer: Peer, { focused = true } = {}): Promise<void> {
  await peer.context.addInitScript((focused) => {
    const record = (hz: number) => {
      const list = JSON.parse(localStorage.getItem("qa-notes") ?? "[]") as number[];
      list.push(hz);
      localStorage.setItem("qa-notes", JSON.stringify(list));
    };
    const node = () => ({ connect: (to: unknown) => to, start() {}, stop() {} });
    class StandInAudio {
      state = "running";
      currentTime = 0;
      destination = {};
      resume() { return Promise.resolve(); }
      decodeAudioData() { return Promise.reject(new Error("stand-in")); }
      createGain() { return { ...node(), gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }
      createOscillator() { return { ...node(), type: "sine", frequency: { setValueAtTime: record } }; }
      createBufferSource() { return { ...node(), buffer: null }; }
    }
    Object.defineProperty(window, "AudioContext", { value: StandInAudio, configurable: true });
    document.hasFocus = () => focused;
  }, focused);
  await peer.page.reload();
  await peer.page.keyboard.press("Shift");
}

/** How many times this peer played the sounds whose first notes are `notes` (each plays its first note once). */
export const heard = (peer: Peer, ...notes: number[]) =>
  peer.page.evaluate((notes) => (JSON.parse(localStorage.getItem("qa-notes") ?? "[]") as number[]).filter((hz) => notes.includes(hz)).length, notes);

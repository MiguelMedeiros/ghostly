/*
 * The Media Session for what the app plays itself (voice messages): the lock screen, the notification shade,
 * headphone buttons and keyboard media keys show it and control it. A `<video>` with its own controls already
 * gets one from the browser. One player at a time owns it; whoever took it last gives it back.
 */

export interface MediaSessionPlayer {
  title: string;
  artist?: string;
  play(): void;
  pause(): void;
  /** Seconds from the start. */
  seekTo(at: number): void;
  /** The next voice message in the chat, where there is one. */
  next?(): void;
}

type Handler = (details: { seekTime?: number; seekOffset?: number }) => void;
interface Session {
  metadata: unknown;
  playbackState: "none" | "paused" | "playing";
  setActionHandler(action: string, handler: Handler | null): void;
  setPositionState?(state?: { duration: number; playbackRate: number; position: number }): void;
}

const ACTIONS = ["play", "pause", "stop", "seekto", "seekbackward", "seekforward", "nexttrack"] as const;
const STEP_SECONDS = 5;

let owner: string | null = null;
let position = { at: 0, duration: 0 };

function session(): Session | null {
  const found = (navigator as { mediaSession?: Session }).mediaSession;
  return found && typeof found.setActionHandler === "function" ? found : null;
}

/**
 * The web app's icons. Only a page on http(s) has them to give: the browser takes artwork from http, https, data and
 * blob URLs only, and the extension (`chrome-extension:`) and the Desktop app ship no such file, so there each voice
 * message logged a warning and showed no picture anyway.
 */
function artwork(): { src: string; sizes: string; type: string }[] {
  if (!/^https?:$/.test(location.protocol)) return [];
  return [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }, { src: "/icon-512.png", sizes: "512x512", type: "image/png" }];
}

/** `id` plays now: the system's controls show it and drive it. */
export function claimMediaSession(id: string, player: MediaSessionPlayer): void {
  const media = session();
  if (!media) return;
  owner = id;
  const Metadata = (globalThis as { MediaMetadata?: new (init: object) => unknown }).MediaMetadata;
  if (Metadata) media.metadata = new Metadata({ title: player.title, artist: player.artist ?? "Ghostly", album: "Ghostly", artwork: artwork() });
  media.playbackState = "playing";
  const set = (action: (typeof ACTIONS)[number], handler: Handler | null) => {
    try { media.setActionHandler(action, handler); } catch { /* an action this browser does not know */ }
  };
  set("play", () => player.play());
  set("pause", () => player.pause());
  set("stop", () => player.pause());
  set("seekto", ({ seekTime }) => { if (typeof seekTime === "number") player.seekTo(seekTime); });
  set("seekbackward", ({ seekOffset }) => player.seekTo(Math.max(0, position.at - (seekOffset ?? STEP_SECONDS))));
  set("seekforward", ({ seekOffset }) => player.seekTo(Math.min(position.duration, position.at + (seekOffset ?? STEP_SECONDS))));
  set("nexttrack", player.next ? () => player.next?.() : null);
}

/** Playing or paused, for the system's play button. Only the owner is heard. */
export function mediaSessionState(id: string, state: "playing" | "paused"): void {
  const media = session();
  if (media && owner === id) media.playbackState = state;
}

/** Where the owner is, for the system's progress bar. */
export function mediaSessionPosition(id: string, at: number, duration: number, playbackRate = 1): void {
  const media = session();
  if (!media || owner !== id) return;
  position = { at, duration };
  if (!(duration > 0) || !Number.isFinite(duration) || !(playbackRate > 0)) return;
  try { media.setPositionState?.({ duration, playbackRate, position: Math.min(Math.max(0, at), duration) }); } catch { /* out of range: left as it was */ }
}

/** `id` stopped for good (ended, or left the screen): the controls go away, unless another player took them. */
export function releaseMediaSession(id: string): void {
  const media = session();
  if (!media || owner !== id) return;
  owner = null;
  position = { at: 0, duration: 0 };
  media.metadata = null;
  media.playbackState = "none";
  for (const action of ACTIONS) {
    try { media.setActionHandler(action, null); } catch { /* not known here */ }
  }
  try { media.setPositionState?.(); } catch { /* nothing to clear */ }
}

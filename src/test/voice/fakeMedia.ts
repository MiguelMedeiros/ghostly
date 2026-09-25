import { vi } from "vitest";

/**
 * A microphone, a MediaRecorder and an AudioContext for happy-dom, which has none: enough of
 * each for the recorder in `lib/voiceRecorder.ts` to run for real. `media.tracks` shows whether
 * the microphone was given back; `media.recorders` what was recorded.
 */
export interface FakeTrack { stop: ReturnType<typeof vi.fn>; readyState: "live" | "ended" }

class FakeMediaRecorder extends EventTarget {
  static supported = new Set(["audio/webm;codecs=opus", "audio/webm"]);
  static isTypeSupported(type: string) { return FakeMediaRecorder.supported.has(type); }

  state: "inactive" | "recording" | "paused" = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  readonly mimeType: string;
  readonly options: MediaRecorderOptions | undefined;
  private part = 0;

  constructor(readonly stream: unknown, options?: MediaRecorderOptions) {
    super();
    this.options = options;
    this.mimeType = options?.mimeType ?? "audio/webm";
    media.recorders.push(this);
  }
  private emit() {
    const data = new Blob([`part-${this.part++};`], { type: this.mimeType });
    const event = Object.assign(new Event("dataavailable"), { data });
    this.ondataavailable?.(event);
    this.dispatchEvent(event);
  }
  start() { this.state = "recording"; }
  pause() { this.state = "paused"; }
  resume() { this.state = "recording"; }
  requestData() { this.emit(); }
  stop() {
    if (this.state === "inactive") return;
    this.emit();
    this.state = "inactive";
    queueMicrotask(() => this.dispatchEvent(new Event("stop")));
  }
}

class FakeAudioContext {
  closed = false;
  createAnalyser() {
    return { fftSize: 1024, getFloatTimeDomainData: (samples: Float32Array) => samples.fill(media.level) };
  }
  createMediaStreamSource() { return { connect() {} }; }
  close() { this.closed = true; return Promise.resolve(); }
}

export const media = {
  /** What the microphone "hears": each sample, so the RMS too. */
  level: 0.1,
  tracks: [] as FakeTrack[],
  recorders: [] as FakeMediaRecorder[],
  getUserMedia: vi.fn<(constraints: MediaStreamConstraints) => Promise<MediaStream>>(),
  /** The microphone answers with this error instead of a stream. */
  deny(name = "NotAllowedError") {
    media.getUserMedia.mockImplementation(async () => { throw new DOMException("denied", name); });
  },
  /** Whether every microphone handed out was given back. */
  released() { return media.tracks.length > 0 && media.tracks.every((track) => track.stop.mock.calls.length > 0); },
};

export function installFakeMedia() {
  media.level = 0.1;
  media.tracks = [];
  media.recorders = [];
  FakeMediaRecorder.supported = new Set(["audio/webm;codecs=opus", "audio/webm"]);
  media.getUserMedia.mockReset();
  media.getUserMedia.mockImplementation(async () => {
    const track: FakeTrack = { readyState: "live", stop: vi.fn(() => { track.readyState = "ended"; }) };
    media.tracks.push(track);
    return { getTracks: () => [track] } as unknown as MediaStream;
  });
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: media.getUserMedia } });
}

export function removeFakeMedia() {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
}

/** Only these types can be recorded (older WKWebView: `["audio/mp4"]`). */
export function recordableTypes(...types: string[]) {
  FakeMediaRecorder.supported = new Set(types);
}

/**
 * Audio elements that "play": `play()` resolves and fires `play`, `pause()` fires `pause`, and
 * `players` lists them so a test can end one. `canPlay` decides what `canPlayType` says.
 */
export const audio = {
  players: [] as HTMLAudioElement[],
  canPlay: (type: string) => (type.startsWith("audio/") ? "maybe" : ""),
};

export function installFakeAudio() {
  audio.players = [];
  audio.canPlay = (type) => (type.startsWith("audio/") ? "maybe" : "");
  const proto = HTMLMediaElement.prototype;
  vi.spyOn(proto, "canPlayType").mockImplementation((type: string) => audio.canPlay(type) as CanPlayTypeResult);
  vi.spyOn(proto, "play").mockImplementation(function (this: HTMLMediaElement) {
    if (!audio.players.includes(this as HTMLAudioElement)) audio.players.push(this as HTMLAudioElement);
    Object.defineProperty(this, "paused", { configurable: true, value: false });
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  vi.spyOn(proto, "pause").mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { configurable: true, value: true });
    this.dispatchEvent(new Event("pause"));
  });
}

/** Plays `player` to its end, as the element would. */
export function endPlayback(player: HTMLAudioElement) {
  Object.defineProperty(player, "paused", { configurable: true, value: true });
  player.dispatchEvent(new Event("ended"));
}

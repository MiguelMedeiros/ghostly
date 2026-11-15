import type { BrowserContext, Page } from "@playwright/test";

/*
 * What a page's sealed call does to its media, measured below LiveKit's events (the group-call spec's sealed test):
 *
 * - `installSealProbe(context)` wraps every LiveKit E2EE worker the page starts in one that runs LiveKit's own worker
 *   unchanged, with a counting stream before and after each transform LiveKit sets up in it. Before: the frame as the
 *   encoder made it (or as it came off the network). After: what LiveKit hands on to the network (or to the decoder).
 *   A frame that came out longer by an AES-GCM tag, an IV and LiveKit's trailer, with other bytes, was sealed; one that
 *   came out the same, byte for byte, went in the clear. It also records every RTCPeerConnection and every sender and
 *   receiver whose encoded streams were taken (Chromium's Insertable Streams, which livekit-client 2.24 uses there
 *   instead of RTCRtpScriptTransform), and reads the connections' own `getStats()`.
 * - `shareTestPattern(context)` makes the page's screen share a canvas with four known colours, so a picture can be
 *   told apart from noise: `pictures(page)` draws the page's video (its received tracks, or the elements a selector
 *   names) to a canvas and says how many of the four quadrants show their colour.
 *
 * Chromium only (Insertable Streams), and a page whose CSP lets it start a blob: worker (the e2e's `vite preview` and
 * the token mock's /smoke page set none). Nothing in LiveKit is patched: the probe sits on the streams LiveKit posts to
 * its worker, and on the browser's own WebRTC objects.
 */

/** The test pattern's four quadrants, left to right and top to bottom: red, green, blue, yellow. */
export const PATTERN: readonly (readonly [number, number, number])[] = [[230, 40, 40], [40, 200, 60], [40, 60, 230], [240, 220, 40]];

/** How far a quadrant's average colour may be from the pattern's, per channel, and still show it (VP8 and YUV drift). */
const TOLERANCE = 56;

/** What one direction of an E2EE worker's transforms saw of one kind of media. */
export interface FrameCounts {
  /** Frames into LiveKit's transform. */
  in: number;
  /** Frames out of it, on to the network (encode) or the decoder (decode). */
  out: number;
  /** Out with no bytes (an audio DTX frame, never sealed by LiveKit). */
  empty: number;
  /** Out longer by at least 28 bytes (tag, IV, trailer), ending in LiveKit's trailer, with other bytes: sealed. */
  sealed: number;
  /** Out shorter by at least 28 bytes: opened with the right key. */
  opened: number;
  /** Out the same size and the same bytes as it went in: passed in the clear. */
  clear: number;
  /** Out as the SFU's own 8x8 blank keyframe or Opus silence (LiveKit's server-injected frames). */
  sif: number;
  /** Into a decode transform ending in LiveKit's trailer (a 12-byte IV): what the wire carried was sealed. */
  trailer: number;
  /** Anything else out. */
  other: number;
}

export interface SealProbe {
  /** E2EE workers the page started, and how many answered (an ended room's worker does not). */
  workers: number;
  answered: number;
  /** Whether each worker found LiveKit's message handler to wrap. */
  hooked: boolean;
  /** Encoded-stream pairs LiveKit handed its workers, per direction. */
  streams: { encode: number; decode: number };
  encode: { video: FrameCounts; audio: FrameCounts };
  decode: { video: FrameCounts; audio: FrameCounts };
  /** Every sender carrying a track on an open connection, and whether its encoded frames go through a transform. */
  senders: { kind: string; transformed: boolean }[];
  /** `getStats()`, summed over the page's open connections. */
  outbound: { video: { framesEncoded: number; framesSent: number; bytesSent: number }; audio: { packetsSent: number; bytesSent: number } };
  inbound: { video: { bytesReceived: number; framesReceived: number; framesDecoded: number; frameWidth: number }; audio: { bytesReceived: number } };
}

/** One video drawn to a canvas: its size, each quadrant's average colour, and how many show the pattern's. */
export interface Picture {
  width: number;
  height: number;
  quadrants: number[][];
  matched: number;
}

/** Runs in each E2EE worker after LiveKit's own script: counts the frames around each transform LiveKit sets up. */
function workerProbe(): void {
  type Frame = { data: ArrayBuffer; type?: string };
  type Transformer = { options?: { kind?: string }; readable: ReadableStream<Frame>; writable: WritableStream<Frame> };
  type Message = { kind?: string; id?: number; data?: { readableStream?: ReadableStream<Frame>; writableStream?: WritableStream<Frame> } } | null;
  const scope = self as unknown as {
    onmessage: ((ev: MessageEvent) => unknown) | null;
    onrtctransform?: ((ev: { transformer: Transformer }) => unknown) | null;
    postMessage(message: unknown): void;
  };
  const blank = () => ({ in: 0, out: 0, empty: 0, sealed: 0, opened: 0, clear: 0, sif: 0, trailer: 0, other: 0 });
  const counts = {
    hooked: typeof scope.onmessage === "function",
    streams: { encode: 0, decode: 0 },
    encode: { video: blank(), audio: blank() },
    decode: { video: blank(), audio: blank() },
  };
  const seen = new WeakMap<object, { size: number; sample: number[] }>();
  const VP8_BLANK = [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0x08, 0x00, 0x08, 0x00];
  const OPUS_SILENCE = [0xf8, 0xff, 0xfe];
  // An RTCEncodedVideoFrame has a `type` (key, delta, empty); an RTCEncodedAudioFrame has none.
  const kindOf = (f: Frame): "video" | "audio" => (typeof f.type === "string" ? "video" : "audio");
  // Bytes past any codec header LiveKit leaves in the clear (VP8's 10 at most, Opus's 1).
  const sample = (bytes: Uint8Array) => Array.from(bytes.subarray(16, 48));
  const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const starts = (bytes: Uint8Array, head: number[]) => head.every((x, i) => bytes[i] === x);

  function wrap(op: "encode" | "decode", readable: ReadableStream<Frame>, writable: WritableStream<Frame>) {
    const c = counts[op];
    counts.streams[op] += 1;
    const before = new TransformStream<Frame, Frame>({
      transform(frame, controller) {
        const bytes = new Uint8Array(frame.data);
        const s = c[kindOf(frame)];
        s.in += 1;
        if (op === "decode" && bytes.length > 2 && bytes[bytes.length - 2] === 12) s.trailer += 1;
        seen.set(frame, { size: bytes.length, sample: sample(bytes) });
        controller.enqueue(frame);
      },
    });
    const after = new TransformStream<Frame, Frame>({
      transform(frame, controller) {
        const bytes = new Uint8Array(frame.data);
        const kind = kindOf(frame);
        const s = c[kind];
        const was = seen.get(frame);
        s.out += 1;
        if (bytes.length === 0) s.empty += 1;
        else if (op === "decode" && bytes.length <= 100 && starts(bytes, kind === "video" ? VP8_BLANK : OPUS_SILENCE)) s.sif += 1;
        else if (!was) s.other += 1;
        else if (bytes.length === was.size && same(sample(bytes), was.sample)) s.clear += 1;
        else if (op === "encode" && bytes.length >= was.size + 28 && bytes[bytes.length - 2] === 12 && (was.sample.length === 0 || !same(sample(bytes), was.sample))) s.sealed += 1;
        else if (op === "decode" && bytes.length <= was.size - 28) s.opened += 1;
        else s.other += 1;
        controller.enqueue(frame);
      },
    });
    void after.readable.pipeTo(writable).catch(() => {});
    return { readable: readable.pipeThrough(before), writable: after.writable };
  }

  // Insertable Streams (Chromium): LiveKit posts each sender's and receiver's encoded streams in an encode or decode message.
  const livekitMessage = scope.onmessage;
  scope.onmessage = (ev: MessageEvent) => {
    const message = ev.data as Message;
    if (message?.kind === "sealProbe") {
      scope.postMessage({ kind: "sealProbe", id: message.id, counts });
      return undefined;
    }
    if ((message?.kind === "encode" || message?.kind === "decode") && message.data?.readableStream && message.data.writableStream) {
      const piped = wrap(message.kind, message.data.readableStream, message.data.writableStream);
      message.data.readableStream = piped.readable;
      message.data.writableStream = piped.writable;
    }
    return livekitMessage?.call(self, ev);
  };
  // RTCRtpScriptTransform (where LiveKit uses it): the same streams, from the transform event.
  const livekitTransform = scope.onrtctransform;
  if (typeof livekitTransform === "function") {
    scope.onrtctransform = (ev: { transformer: Transformer }) => {
      const t = ev.transformer;
      const op = t.options?.kind;
      if (op !== "encode" && op !== "decode") return livekitTransform.call(self, ev);
      const piped = wrap(op, t.readable, t.writable);
      return livekitTransform.call(self, { transformer: { options: t.options, readable: piped.readable, writable: piped.writable } });
    };
  }
}

/** Runs in the page before its own scripts: the worker wrapper, the connection list, `sealProbe()` and `sealPicture()`. */
function pageProbe({ workerSource, pattern, tolerance }: { workerSource: string; pattern: number[][]; tolerance: number }): void {
  const w = window as unknown as Record<string, unknown>;
  if (w.sealProbe) return;
  const workers: Worker[] = [];
  const connections: RTCPeerConnection[] = [];
  const transformed = new WeakSet<object>();

  const RealWorker = window.Worker;
  const Probed = function (url: string | URL, options?: WorkerOptions): Worker {
    const href = new URL(String(url), location.href).href;
    if (!/e2ee\.worker/.test(href)) return new RealWorker(url, options);
    const head = options?.type === "module" ? `import ${JSON.stringify(href)};\n` : `importScripts(${JSON.stringify(href)});\n`;
    const worker = new RealWorker(URL.createObjectURL(new Blob([head, workerSource], { type: "text/javascript" })), options);
    workers.push(worker);
    return worker;
  };
  Probed.prototype = RealWorker.prototype;
  Object.defineProperty(window, "Worker", { configurable: true, writable: true, value: Probed });

  const RealConnection = window.RTCPeerConnection;
  class ProbedConnection extends RealConnection {
    constructor(configuration?: RTCConfiguration) {
      super(configuration);
      connections.push(this);
    }
  }
  Object.defineProperty(window, "RTCPeerConnection", { configurable: true, writable: true, value: ProbedConnection });

  for (const C of [window.RTCRtpSender, window.RTCRtpReceiver]) {
    const proto = C?.prototype as unknown as { createEncodedStreams?: (...args: unknown[]) => unknown } | undefined;
    const original = proto?.createEncodedStreams;
    if (!proto || !original) continue;
    proto.createEncodedStreams = function (this: object, ...args: unknown[]) {
      transformed.add(this);
      return original.apply(this, args);
    };
  }

  const open = () => connections.filter((pc) => pc.connectionState !== "closed");
  const ask = (worker: Worker) => new Promise<Record<string, unknown> | null>((resolve) => {
    const id = Math.random();
    const done = (value: Record<string, unknown> | null) => {
      clearTimeout(timer);
      worker.removeEventListener("message", heard);
      resolve(value);
    };
    const heard = (ev: MessageEvent) => {
      if (ev.data?.kind === "sealProbe" && ev.data.id === id) done(ev.data.counts);
    };
    const timer = setTimeout(() => done(null), 3000);
    worker.addEventListener("message", heard);
    worker.postMessage({ kind: "sealProbe", id });
  });

  w.sealProbe = async () => {
    const senders = open().flatMap((pc) => pc.getSenders()).filter((s) => s.track)
      .map((s) => ({ kind: s.track!.kind, transformed: transformed.has(s) || !!(s as unknown as { transform?: unknown }).transform }));
    const outbound = { video: { framesEncoded: 0, framesSent: 0, bytesSent: 0 }, audio: { packetsSent: 0, bytesSent: 0 } };
    const inbound = { video: { bytesReceived: 0, framesReceived: 0, framesDecoded: 0, frameWidth: 0 }, audio: { bytesReceived: 0 } };
    for (const pc of open()) {
      (await pc.getStats()).forEach((s: Record<string, number | string | undefined>) => {
        const n = (key: string) => (typeof s[key] === "number" ? (s[key] as number) : 0);
        if (s.type === "outbound-rtp" && s.kind === "video") {
          outbound.video.framesEncoded += n("framesEncoded");
          outbound.video.framesSent += n("framesSent");
          outbound.video.bytesSent += n("bytesSent");
        } else if (s.type === "outbound-rtp" && s.kind === "audio") {
          outbound.audio.packetsSent += n("packetsSent");
          outbound.audio.bytesSent += n("bytesSent");
        } else if (s.type === "inbound-rtp" && s.kind === "video") {
          inbound.video.bytesReceived += n("bytesReceived");
          inbound.video.framesReceived += n("framesReceived");
          inbound.video.framesDecoded += n("framesDecoded");
          inbound.video.frameWidth = Math.max(inbound.video.frameWidth, n("frameWidth"));
        } else if (s.type === "inbound-rtp" && s.kind === "audio") {
          inbound.audio.bytesReceived += n("bytesReceived");
        }
      });
    }
    const answers = (await Promise.all(workers.map(ask))).filter((a): a is Record<string, unknown> => a !== null);
    type Counts = Record<string, number>;
    type Sides = Record<"video" | "audio", Counts>;
    const sum = (op: "encode" | "decode"): Sides => {
      const total: Sides = { video: {}, audio: {} };
      for (const a of answers) {
        for (const kind of ["video", "audio"] as const) {
          for (const [key, value] of Object.entries((a[op] as Sides)[kind])) total[kind][key] = (total[kind][key] ?? 0) + value;
        }
      }
      return total;
    };
    const streams = { encode: 0, decode: 0 };
    for (const a of answers) {
      const s = a.streams as { encode: number; decode: number };
      streams.encode += s.encode;
      streams.decode += s.decode;
    }
    return {
      workers: workers.length,
      answered: answers.length,
      hooked: answers.length > 0 && answers.every((a) => a.hooked === true),
      streams,
      encode: sum("encode"),
      decode: sum("decode"),
      senders,
      outbound,
      inbound,
    };
  };

  const shot = (video: HTMLVideoElement) => {
    const width = video.videoWidth, height = video.videoHeight;
    if (!width || !height) return { width, height, quadrants: [], matched: 0 };
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(video, 0, 0, width, height);
    const r = Math.max(1, Math.floor(Math.min(width, height) / 16));
    const quadrants = pattern.map((_, i) => {
      const cx = Math.floor((((i % 2) * 2 + 1) * width) / 4), cy = Math.floor(((Math.floor(i / 2) * 2 + 1) * height) / 4);
      const data = g.getImageData(Math.max(0, cx - r), Math.max(0, cy - r), 2 * r, 2 * r).data;
      const rgb = [0, 0, 0];
      for (let p = 0; p < data.length; p += 4) for (let ch = 0; ch < 3; ch++) rgb[ch] += data[p + ch];
      return rgb.map((v) => Math.round(v / (data.length / 4)));
    });
    const matched = quadrants.filter((q, i) => q.every((v, ch) => Math.abs(v - pattern[i][ch]) <= tolerance)).length;
    return { width, height, quadrants, matched };
  };

  // The videos a selector names, or else every video track the page's connections receive, each in a muted element
  // of the probe's own: what the decoder made of it, whatever the page does with the track.
  w.sealPicture = async (selector?: string) => {
    if (selector) return [...document.querySelectorAll<HTMLVideoElement>(selector)].map(shot);
    const tracks = open().flatMap((pc) => pc.getReceivers()).map((r) => r.track).filter((t) => t.kind === "video" && t.readyState === "live");
    const videos = tracks.map((track) => {
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.style.cssText = "position:fixed;left:0;top:0;width:32px;height:18px;opacity:0.01;pointer-events:none";
      video.srcObject = new MediaStream([track]);
      document.body.append(video);
      void video.play().catch(() => {});
      return video;
    });
    for (let waited = 0; waited < 3000 && videos.some((v) => !v.videoWidth); waited += 100) await new Promise((done) => setTimeout(done, 100));
    const shots = videos.map(shot);
    for (const video of videos) {
      video.pause();
      video.srcObject = null;
      video.remove();
    }
    return shots;
  };
}

/** Every page of `context` probes its E2EE workers and connections: call before the page loads. */
export async function installSealProbe(context: BrowserContext): Promise<void> {
  await context.addInitScript(pageProbe, { workerSource: `(${workerProbe.toString()})();\n`, pattern: PATTERN.map((c) => [...c]), tolerance: TOLERANCE });
}

/** The page's screen share is the test pattern: four colour blocks on a 640x360 canvas, redrawn 15 times a second. */
export async function shareTestPattern(context: BrowserContext): Promise<void> {
  await context.addInitScript((pattern: number[][]) => {
    const media = navigator.mediaDevices;
    if (!media) return;
    Object.defineProperty(media, "getDisplayMedia", {
      configurable: true,
      value: async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 360;
        const g = canvas.getContext("2d")!;
        let tick = 0;
        const draw = () => {
          pattern.forEach(([r, gr, b], i) => {
            g.fillStyle = `rgb(${r}, ${gr}, ${b})`;
            g.fillRect((i % 2) * 320, Math.floor(i / 2) * 180, 320, 180);
          });
          // A small mark along the bottom edge, so every frame differs and the encoder keeps sending.
          g.fillStyle = "#fff";
          g.fillRect((tick++ * 8) % 640, 352, 8, 8);
        };
        draw();
        const stream = canvas.captureStream(15);
        setInterval(draw, 66);
        return stream;
      },
    });
  }, PATTERN.map((c) => [...c]));
}

/** The page's probe now. */
export const sealProbe = (page: Page): Promise<SealProbe> => page.evaluate(() => (window as unknown as { sealProbe(): Promise<SealProbe> }).sealProbe());

/** The page's received video (or the elements `selector` names), drawn to a canvas against the pattern. */
export const pictures = (page: Page, selector?: string): Promise<Picture[]> =>
  page.evaluate((s) => (window as unknown as { sealPicture(s?: string): Promise<Picture[]> }).sealPicture(s), selector);

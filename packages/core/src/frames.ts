import { utf8Encode } from "./bytes";
import { sanitizeNick } from "./text";

/**
 * Framing on the `ghostly/1` DataChannel (ordered, reliable).
 *
 * - Text messages are control frames: compact JSON with a `t` discriminator,
 *   the same shape Ghostly already uses for `_msgs` and `_call`.
 * - Binary messages are body chunks that belong to a stream opened by a
 *   control frame: `<kind u8><stream id u32 BE><flags u8><payload>`.
 *
 * Everything here handles data from the remote peer and must never trust it.
 */
export const LIMITS = {
  /** Largest control frame accepted, headers included. */
  maxControlFrameBytes: 60 * 1024,
  /** Largest DataChannel message sent. 16 KiB is safe across WebRTC stacks. */
  maxChunkMessageBytes: 16 * 1024,
  maxRequestBodyBytes: 8 * 1024 * 1024,
  maxResponseBodyBytes: 64 * 1024 * 1024,
  maxHeaderCount: 128,
  maxHeaderValueBytes: 16 * 1024,
  maxPathBytes: 8 * 1024,
  /** Requests a host serves at once for one peer. */
  maxConcurrentRequestsPerPeer: 32,
  /** Requests a client keeps in flight; the rest wait in a queue. */
  maxClientInFlight: 16,
  maxChatMessageBytes: 16 * 1024,
  maxFileBytes: 100 * 1024 * 1024,
  /** Files a peer may be sending us at once. */
  maxIncomingFilesPerPeer: 3,
  /** Received bytes kept for one peer, in flight included. Past it new files are refused. */
  maxStoredIncomingBytesPerPeer: 500 * 1024 * 1024,
  requestTimeoutMs: 60_000,
  bodyIdleTimeoutMs: 30_000,
  /** Stop writing to the channel above this many buffered bytes. */
  sendHighWaterMark: 1024 * 1024,
  sendLowWaterMark: 256 * 1024,
} as const;

export const PROTOCOL_VERSION = 1;

export const CHUNK_KIND = { requestBody: 1, responseBody: 2, fileBody: 3 } as const;
export type ChunkKind = (typeof CHUNK_KIND)[keyof typeof CHUNK_KIND];

export const CHUNK_FLAG_END = 1;
const CHUNK_HEADER_BYTES = 6;
export const MAX_CHUNK_PAYLOAD_BYTES = LIMITS.maxChunkMessageBytes - CHUNK_HEADER_BYTES;

export type HeaderList = [string, string][];

/** First frame in each direction once the channel opens. */
export interface HelloFrame {
  t: "hello";
  v: number;
  /** Authoritative service list, same wire shape as the `_svc` record. */
  svc: unknown;
  nick?: string;
}

/** Chat message. Used instead of `_msgs` while the data link is up. */
export interface ChatFrame {
  t: "m";
  ts: number;
  m: string;
}

/** A `_call` signal, sent here as well so a connected peer rings without waiting for its next poll. */
export interface CallFrame {
  t: "call";
  s: string;
}

/** Updated service list while connected. */
export interface ServicesFrame {
  t: "svc";
  svc: unknown;
}

export interface HttpRequestFrame {
  t: "req";
  id: number;
  /** Service id. The host maps it to a target; the peer never names a URL. */
  s: string;
  m: string;
  /** Origin-form path with query, e.g. `/api/items?page=2` */
  p: string;
  h: HeaderList;
  /** True when request body chunks follow. */
  b: boolean;
}

export interface HttpResponseFrame {
  t: "res";
  id: number;
  st: number;
  h: HeaderList;
  /** True when response body chunks follow. */
  b: boolean;
}

/** Announces a file; its bytes follow as `fileBody` chunks on stream `id`. */
export interface FileFrame {
  t: "file";
  id: number;
  /** File id chosen by the sender, unique within the link. */
  f: string;
  ts: number;
  n: string;
  /** Size in bytes. The transfer fails unless exactly this many arrive. */
  s: number;
  m: string;
}

/**
 * A way to get paid, in Paykit's terms: a Payment Endpoint Identifier
 * (`btc-lightning-bolt11`, `cashu`, …) and its payload (an invoice, the mints
 * accepted, …). See `payments.ts`.
 */
export type WireEndpoint = [identifier: string, payload: string];

/** Payment Request: the sender asks to be paid. */
export interface PayRequestFrame {
  t: "pay-req";
  /** Request id, chosen by the payee. */
  id: string;
  ts: number;
  /** Decimal amount as text, and its asset (`sat`). */
  v: string;
  u: string;
  memo?: string;
  e: WireEndpoint[];
}

/** A payment that travels in band, such as an ecash token. */
export interface PayFrame {
  t: "pay";
  id: string;
  ts: number;
  /** The request this settles, if any. */
  rid?: string;
  v: string;
  u: string;
  memo?: string;
  /** The endpoint used and the payment itself. */
  e: WireEndpoint;
}

/** What became of a payment or a request: the payee's receipt, or a refusal. */
export interface PayResultFrame {
  t: "pay-res";
  /** Id of the `pay` or `pay-req` frame this answers. */
  id: string;
  ok: boolean;
  /** Amount credited, when it differs from what was sent (fees). */
  v?: string;
  err?: string;
}

/** Aborts a stream in either direction. */
export interface ResetFrame {
  t: "rst";
  id: number;
  /** Which stream: `q` a request I sent, `s` a response I am sending, `f` a file (either side). */
  d: "q" | "s" | "f";
  e: string;
}

export interface PingFrame {
  t: "ping" | "pong";
  ts: number;
}

export type ControlFrame =
  | HelloFrame
  | ChatFrame
  | CallFrame
  | ServicesFrame
  | HttpRequestFrame
  | HttpResponseFrame
  | FileFrame
  | PayRequestFrame
  | PayFrame
  | PayResultFrame
  | ResetFrame
  | PingFrame;

export interface ChunkFrame {
  kind: ChunkKind;
  id: number;
  end: boolean;
  payload: Uint8Array;
}

export function encodeControl(frame: ControlFrame): string {
  const json = JSON.stringify(frame);
  if (utf8Encode(json).length > LIMITS.maxControlFrameBytes) throw new Error("Control frame too large");
  return json;
}

function isHeaderList(value: unknown): value is HeaderList {
  if (!Array.isArray(value) || value.length > LIMITS.maxHeaderCount) return false;
  return value.every(
    (h) =>
      Array.isArray(h) &&
      h.length === 2 &&
      typeof h[0] === "string" &&
      typeof h[1] === "string" &&
      h[0].length <= 256 &&
      h[1].length <= LIMITS.maxHeaderValueBytes,
  );
}

function isStreamId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

function isPayId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value);
}

/** Decimal text, as in Paykit's Payment Amount: no floats on the wire. */
function isAmount(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d{0,15})(\.\d{1,8})?$/.test(value);
}

function isUnit(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]{1,12}$/.test(value);
}

function isEndpoint(value: unknown): value is WireEndpoint {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    /^[a-z0-9][a-z0-9-]{0,63}$/.test(value[0]) &&
    typeof value[1] === "string" &&
    value[1].length <= 32 * 1024
  );
}

/** Returns null for anything malformed; callers drop the frame. */
export function decodeControl(text: string): ControlFrame | null {
  if (text.length > LIMITS.maxControlFrameBytes) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;

  switch (f.t) {
    case "hello":
      if (typeof f.v !== "number") return null;
      return { t: "hello", v: f.v, svc: f.svc, nick: sanitizeNick(f.nick) };
    case "m":
      if (typeof f.ts !== "number" || typeof f.m !== "string") return null;
      if (f.m.length > LIMITS.maxChatMessageBytes) return null;
      return { t: "m", ts: f.ts, m: f.m };
    case "call":
      if (typeof f.s !== "string" || f.s.length > LIMITS.maxChatMessageBytes) return null;
      return { t: "call", s: f.s };
    case "svc":
      return { t: "svc", svc: f.svc };
    case "req":
      if (!isStreamId(f.id) || typeof f.s !== "string" || typeof f.m !== "string") return null;
      if (typeof f.p !== "string" || f.p.length > LIMITS.maxPathBytes || !isHeaderList(f.h)) return null;
      return { t: "req", id: f.id, s: f.s, m: f.m, p: f.p, h: f.h, b: f.b === true };
    case "res":
      if (!isStreamId(f.id) || typeof f.st !== "number" || !Number.isInteger(f.st)) return null;
      if (f.st < 100 || f.st > 599 || !isHeaderList(f.h)) return null;
      return { t: "res", id: f.id, st: f.st, h: f.h, b: f.b === true };
    case "file":
      if (!isStreamId(f.id) || typeof f.f !== "string" || typeof f.ts !== "number") return null;
      if (typeof f.n !== "string" || typeof f.m !== "string") return null;
      if (typeof f.s !== "number" || !Number.isSafeInteger(f.s) || f.s < 0) return null;
      return { t: "file", id: f.id, f: f.f, ts: f.ts, n: f.n, s: f.s, m: f.m };
    case "pay-req":
    case "pay": {
      if (!isPayId(f.id) || typeof f.ts !== "number" || !isAmount(f.v) || !isUnit(f.u)) return null;
      const memo = typeof f.memo === "string" ? f.memo.slice(0, 140) : undefined;
      if (f.t === "pay-req") {
        if (!Array.isArray(f.e) || f.e.length === 0 || f.e.length > 8 || !f.e.every(isEndpoint)) return null;
        return { t: "pay-req", id: f.id, ts: f.ts, v: f.v, u: f.u, memo, e: f.e };
      }
      if (!isEndpoint(f.e) || (f.rid !== undefined && !isPayId(f.rid))) return null;
      return { t: "pay", id: f.id, ts: f.ts, rid: f.rid, v: f.v, u: f.u, memo, e: f.e };
    }
    case "pay-res":
      if (!isPayId(f.id) || typeof f.ok !== "boolean") return null;
      if (f.v !== undefined && !isAmount(f.v)) return null;
      return { t: "pay-res", id: f.id, ok: f.ok, v: f.v, err: typeof f.err === "string" ? f.err.slice(0, 200) : undefined };
    case "rst":
      if (!isStreamId(f.id) || (f.d !== "q" && f.d !== "s" && f.d !== "f")) return null;
      return { t: "rst", id: f.id, d: f.d, e: typeof f.e === "string" ? f.e.slice(0, 256) : "" };
    case "ping":
    case "pong":
      if (typeof f.ts !== "number") return null;
      return { t: f.t, ts: f.ts };
    default:
      return null;
  }
}

export function encodeChunk(chunk: ChunkFrame): Uint8Array {
  if (chunk.payload.length > MAX_CHUNK_PAYLOAD_BYTES) throw new Error("Chunk payload too large");
  const out = new Uint8Array(CHUNK_HEADER_BYTES + chunk.payload.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, chunk.kind);
  view.setUint32(1, chunk.id);
  view.setUint8(5, chunk.end ? CHUNK_FLAG_END : 0);
  out.set(chunk.payload, CHUNK_HEADER_BYTES);
  return out;
}

export function decodeChunk(data: Uint8Array): ChunkFrame | null {
  if (data.length < CHUNK_HEADER_BYTES || data.length > LIMITS.maxChunkMessageBytes) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const kind = view.getUint8(0);
  if (kind !== CHUNK_KIND.requestBody && kind !== CHUNK_KIND.responseBody && kind !== CHUNK_KIND.fileBody) return null;
  return {
    kind,
    id: view.getUint32(1),
    end: (view.getUint8(5) & CHUNK_FLAG_END) !== 0,
    payload: data.subarray(CHUNK_HEADER_BYTES),
  };
}

/**
 * The slice of RTCDataChannel the protocol needs. Tests use an in-memory pair,
 * platforms wrap a real channel with `wrapDataChannel`.
 */
export interface FrameChannel {
  send(data: string | Uint8Array): void;
  readonly bufferedAmount: number;
  /** Resolves once the send buffer has drained below the low water mark. */
  drained(): Promise<void>;
  close(): void;
  onMessage: ((data: string | Uint8Array) => void) | null;
  onClose: (() => void) | null;
}

export function wrapDataChannel(dc: RTCDataChannel): FrameChannel {
  dc.binaryType = "arraybuffer";
  dc.bufferedAmountLowThreshold = LIMITS.sendLowWaterMark;

  const channel: FrameChannel = {
    send(data) {
      if (dc.readyState !== "open") throw new Error("Data link is not open");
      if (typeof data === "string") dc.send(data);
      else dc.send(data as unknown as ArrayBuffer);
    },
    get bufferedAmount() {
      return dc.bufferedAmount;
    },
    drained() {
      if (dc.bufferedAmount <= LIMITS.sendLowWaterMark || dc.readyState !== "open") return Promise.resolve();
      return new Promise<void>((resolve) => {
        const done = () => {
          dc.removeEventListener("bufferedamountlow", done);
          dc.removeEventListener("close", done);
          resolve();
        };
        dc.addEventListener("bufferedamountlow", done);
        dc.addEventListener("close", done);
      });
    },
    close() {
      dc.close();
    },
    onMessage: null,
    onClose: null,
  };

  dc.addEventListener("message", (event) => {
    const data = event.data;
    if (typeof data === "string") channel.onMessage?.(data);
    else if (data instanceof ArrayBuffer) channel.onMessage?.(new Uint8Array(data));
  });
  dc.addEventListener("close", () => channel.onClose?.());
  return channel;
}

/** Writes a body as chunks, honouring backpressure. Always ends with an END chunk. */
export async function sendBody(
  channel: FrameChannel,
  kind: ChunkKind,
  id: number,
  body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  isCancelled: () => boolean = () => false,
): Promise<void> {
  for await (const part of body) {
    for (let offset = 0; offset < part.length; offset += MAX_CHUNK_PAYLOAD_BYTES) {
      if (isCancelled()) return;
      if (channel.bufferedAmount > LIMITS.sendHighWaterMark) await channel.drained();
      const payload = part.subarray(offset, offset + MAX_CHUNK_PAYLOAD_BYTES);
      channel.send(encodeChunk({ kind, id, end: false, payload }));
    }
  }
  if (isCancelled()) return;
  channel.send(encodeChunk({ kind, id, end: true, payload: new Uint8Array(0) }));
}

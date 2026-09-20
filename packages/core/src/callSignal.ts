/**
 * Signaling for voice/video calls, carried in the `_call` record. A full SDP
 * does not fit in a Pkarr packet, so only the session-specific parameters
 * travel and each side rebuilds the SDP around them.
 */
export interface CallSignal {
  /** offer, answer, hang-up, or "my picture changed" while the call is up. */
  t: "o" | "a" | "h" | "v";
  ts: number;
  u?: string;
  p?: string;
  f?: string;
  s?: string;
  m?: string[];
  c?: string[];
  ss?: number[];
  /** 1 while this peer is sending a picture, 0 while it is not. */
  v?: number;
  /** What the picture is: the camera or a screen. Only meaningful with `v: 1`. */
  k?: "c" | "s";
}

export type CallState = "idle" | "offering" | "incoming" | "answering" | "connecting" | "connected" | "ended";

export type CallEventType =
  | "call_started"
  | "call_received"
  | "call_connected"
  | "call_ended"
  | "call_missed"
  | "call_rejected";

export function compressSdp(sdp: string): string {
  return btoa(sdp);
}

export function decompressSdp(compressed: string): string {
  return atob(compressed);
}

export const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
    { urls: "stun:stun4.l.google.com:19302" },
  ],
  iceCandidatePoolSize: 10,
};

export function extractParamsFromSdp(sdp: string): Partial<CallSignal> {
  const lines = sdp.split("\r\n");

  let ufrag = "";
  let pwd = "";
  let fingerprint = "";
  let setup = "";
  const media: string[] = [];
  const candidates: string[] = [];
  let audioSsrc: number | null = null;
  let videoSsrc: number | null = null;
  let currentMedia = "";

  for (const line of lines) {
    if (line.startsWith("a=ice-ufrag:") && !ufrag) {
      ufrag = line.substring("a=ice-ufrag:".length);
    }
    if (line.startsWith("a=ice-pwd:") && !pwd) {
      pwd = line.substring("a=ice-pwd:".length);
    }
    if (line.startsWith("a=fingerprint:sha-256 ") && !fingerprint) {
      fingerprint = line
        .substring("a=fingerprint:sha-256 ".length)
        .replace(/:/g, "");
    }
    if (line.startsWith("a=setup:") && !setup) {
      setup = line.substring("a=setup:".length);
    }
    if (line.startsWith("m=audio")) {
      media.push("a");
      currentMedia = "a";
    }
    if (line.startsWith("m=video")) {
      media.push("v");
      currentMedia = "v";
    }
    if (line.startsWith("a=candidate:")) {
      candidates.push(line.substring("a=candidate:".length));
    }
    if (line.startsWith("a=ssrc:")) {
      const ssrcMatch = line.match(/^a=ssrc:(\d+)/);
      if (ssrcMatch) {
        const ssrc = parseInt(ssrcMatch[1], 10);
        if (currentMedia === "a" && audioSsrc === null) {
          audioSsrc = ssrc;
        } else if (currentMedia === "v" && videoSsrc === null) {
          videoSsrc = ssrc;
        }
      }
    }
  }

  const srflxCandidates = candidates.filter(c => c.includes(" srflx "));
  const hostCandidates = candidates.filter(c => c.includes(" host ") && c.includes(" udp "));
  // Include 1 host candidate (for local connections) and 1 srflx (for remote)
  // Keep packet size under 1000 bytes DHT limit
  const selectedCandidates = [
    ...hostCandidates.slice(0, 1),
    ...srflxCandidates.slice(0, 1),
  ];
  
  const ssrcs: number[] = [];
  if (audioSsrc !== null) ssrcs.push(audioSsrc);
  if (videoSsrc !== null) ssrcs.push(videoSsrc);
  
  return {
    u: ufrag,
    p: pwd,
    f: fingerprint,
    s: setup,
    m: media,
    c: selectedCandidates,
    ss: ssrcs,
  };
}

/** Offers, answers and hang-ups older (or further in the future) than this are ignored. */
export const CALL_SIGNAL_MAX_AGE_MS = 120_000;

/** RFC 8839: ice-char is ALPHA / DIGIT / "+" / "/"; ufrag is 4-256 of them, pwd 22-256. */
const ICE_UFRAG = /^[A-Za-z0-9+/]{4,256}$/;
const ICE_PWD = /^[A-Za-z0-9+/]{22,256}$/;
const ICE_FOUNDATION = /^[A-Za-z0-9+/]{1,32}$/;
const CANDIDATE_ADDRESS = /^[A-Za-z0-9.:-]{1,64}$/;
const CANDIDATE_TYPES = new Set(["host", "srflx", "prflx", "relay"]);
const EXTENSION_TOKEN = /^[A-Za-z0-9+/._-]{1,64}$/;
const DIGITS = /^\d{1,10}$/;
const MAX_CANDIDATES = 8;

function uint(value: string, max: number): number | null {
  if (!DIGITS.test(value)) return null;
  const n = Number(value);
  return n <= max ? n : null;
}

/**
 * Parses the part of an `a=candidate:` line that the signal carries
 * (`foundation component transport priority address port typ type [raddr a rport p] [ext value]...`)
 * and serializes it again from the validated parts. Returns `undefined` for a
 * well-formed candidate that is not UDP (skipped) and `null` for anything malformed.
 */
function normalizeCandidate(candidate: unknown): string | null | undefined {
  if (typeof candidate !== "string" || candidate.length > 512) return null;
  const parts = candidate.split(" ");
  if (parts.length < 8 || parts[6] !== "typ") return null;
  const [foundation, componentStr, transport, priorityStr, address, portStr, , type] = parts;
  const component = uint(componentStr, 256);
  const priority = uint(priorityStr, 0xffffffff);
  const port = uint(portStr, 65535);
  if (!ICE_FOUNDATION.test(foundation) || component === null || component < 1) return null;
  if (!/^[A-Za-z]{1,8}$/.test(transport) || priority === null || port === null) return null;
  if (!CANDIDATE_ADDRESS.test(address) || !CANDIDATE_TYPES.has(type)) return null;

  let raddr: string | null = null;
  let rport: number | null = null;
  const rest = parts.slice(8);
  if (rest.length % 2 !== 0) return null;
  for (let i = 0; i < rest.length; i += 2) {
    const [name, value] = [rest[i], rest[i + 1]];
    if (!EXTENSION_TOKEN.test(name) || !EXTENSION_TOKEN.test(value)) return null;
    if (name === "raddr") {
      if (!CANDIDATE_ADDRESS.test(value)) return null;
      raddr = value;
    } else if (name === "rport") {
      rport = uint(value, 65535);
      if (rport === null) return null;
    }
    // Other extension attributes (generation, network-id, ufrag...) are dropped.
  }

  if (transport.toLowerCase() !== "udp") return undefined;
  let line = `${foundation} ${component} udp ${priority} ${address} ${port} typ ${type}`;
  if (raddr !== null && rport !== null) line += ` raddr ${raddr} rport ${rport}`;
  return line;
}

/**
 * Validates an untrusted `_call` signal (from the Pkarr record or a `call`
 * frame). Every value that ends up in the rebuilt SDP is checked against an
 * anchored pattern and candidates are re-serialized from their parts, so a peer
 * cannot inject SDP lines. Signals outside {@link CALL_SIGNAL_MAX_AGE_MS} of
 * `now` are rejected so that a stale packet does not ring.
 */
export function parseCallSignal(json: string, now = Date.now()): CallSignal | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (raw.t !== "o" && raw.t !== "a" && raw.t !== "h" && raw.t !== "v") return null;
  if (typeof raw.ts !== "number" || !Number.isFinite(raw.ts)) return null;
  if (Math.abs(now - raw.ts) > CALL_SIGNAL_MAX_AGE_MS) return null;
  if (raw.t === "h") return { t: "h", ts: raw.ts };

  const picture = parsePicture(raw);
  if (picture === null) return null;
  // A media state carries no ICE: it only says whether a picture is on, and which.
  if (raw.t === "v") return { t: "v", ts: raw.ts, ...picture };

  if (typeof raw.u !== "string" || !ICE_UFRAG.test(raw.u)) return null;
  if (typeof raw.p !== "string" || !ICE_PWD.test(raw.p)) return null;
  if (typeof raw.f !== "string" || !/^[0-9a-fA-F]{64}$/.test(raw.f)) return null;
  if (raw.s !== "actpass" && raw.s !== "active" && raw.s !== "passive") return null;

  let media: string[] | undefined;
  if (raw.m !== undefined) {
    if (!Array.isArray(raw.m) || raw.m.length < 1 || raw.m.length > 2) return null;
    if (!raw.m.every((m) => m === "a" || m === "v") || new Set(raw.m).size !== raw.m.length) return null;
    media = [...raw.m];
  }

  let ssrcs: number[] | undefined;
  if (raw.ss !== undefined) {
    if (!Array.isArray(raw.ss) || raw.ss.length > 2) return null;
    if (!raw.ss.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff)) return null;
    ssrcs = [...raw.ss];
  }

  const candidates: string[] = [];
  if (raw.c !== undefined) {
    if (!Array.isArray(raw.c) || raw.c.length > MAX_CANDIDATES) return null;
    for (const c of raw.c) {
      const normalized = normalizeCandidate(c);
      if (normalized === null) return null;
      if (normalized !== undefined) candidates.push(normalized);
    }
  }

  return { t: raw.t, ts: raw.ts, u: raw.u, p: raw.p, f: raw.f, s: raw.s, m: media, c: candidates, ss: ssrcs, ...picture };
}

/** The `v`/`k` pair of any signal. Returns null for a malformed one, `{}` when it says nothing. */
function parsePicture(raw: Record<string, unknown>): Pick<CallSignal, "v" | "k"> | null {
  const picture: Pick<CallSignal, "v" | "k"> = {};
  if (raw.v !== undefined) {
    if (raw.v !== 0 && raw.v !== 1) return null;
    picture.v = raw.v;
  }
  if (raw.k !== undefined) {
    if (raw.k !== "c" && raw.k !== "s") return null;
    picture.k = raw.k;
  }
  return picture;
}

/**
 * Whether the peer that sent this offer or answer is sending a picture.
 *
 * Since v2 every call negotiates a video section, on or off, so the media list
 * no longer answers this: `v` does. A v1 peer sends no `v`, and there the video
 * section only carries an SSRC when it is really sending on it.
 */
export function signalHasVideo(signal: CallSignal | null): boolean {
  if (!signal) return false;
  if (signal.v !== undefined) return signal.v === 1;
  return (signal.m?.includes("v") ?? false) && (signal.ss?.length ?? 0) > 1;
}

/**
 * Rebuilds an SDP around a signal. Only pass signals returned by {@link parseCallSignal}.
 *
 * Offer and answer are built the same way: which of the two this is comes from
 * the signal itself, as `a=setup:`, not from the caller.
 */
export function buildSdpFromSignal(signal: CallSignal): string {
  const hexPairs = signal.f!.match(/.{2}/g)!;
  const fingerprint = `sha-256 ${hexPairs.join(":")}`;
  
  const mediaOrder = signal.m ?? ["a"];
  
  const sessionId = Math.floor(Math.random() * 1e15);
  const audioSsrc = signal.ss?.[0] ?? Math.floor(Math.random() * 0xFFFFFFFF);
  const videoSsrc = signal.ss?.[1] ?? Math.floor(Math.random() * 0xFFFFFFFF);

  const lines: string[] = [
    "v=0",
    `o=- ${sessionId} 2 IN IP4 127.0.0.1`,
    "s=-",
    "t=0 0",
  ];

  const mids = mediaOrder.map((_, i) => String(i));
  lines.push(`a=group:BUNDLE ${mids.join(" ")}`);
  lines.push("a=msid-semantic: WMS stream");

  mediaOrder.forEach((mediaType, idx) => {
    const mid = String(idx);
    
    if (mediaType === "a") {
      lines.push(
        "m=audio 9 UDP/TLS/RTP/SAVPF 111",
        "c=IN IP4 0.0.0.0",
        "a=rtcp:9 IN IP4 0.0.0.0",
      );
      for (const c of signal.c ?? []) {
        lines.push(`a=candidate:${c}`);
      }
      lines.push(
        "a=end-of-candidates",
        `a=ice-ufrag:${signal.u}`,
        `a=ice-pwd:${signal.p}`,
        `a=fingerprint:${fingerprint}`,
        `a=setup:${signal.s}`,
        `a=mid:${mid}`,
        "a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level",
        "a=sendrecv",
        "a=msid:stream audio0",
        "a=rtcp-mux",
        "a=rtpmap:111 opus/48000/2",
        "a=fmtp:111 minptime=10;useinbandfec=1",
        `a=ssrc:${audioSsrc} cname:pkarr`,
        `a=ssrc:${audioSsrc} msid:stream audio0`,
      );
    } else if (mediaType === "v") {
      lines.push(
        "m=video 9 UDP/TLS/RTP/SAVPF 96",
        "c=IN IP4 0.0.0.0",
        "a=rtcp:9 IN IP4 0.0.0.0",
      );
      for (const c of signal.c ?? []) {
        lines.push(`a=candidate:${c}`);
      }
      lines.push(
        "a=end-of-candidates",
        `a=ice-ufrag:${signal.u}`,
        `a=ice-pwd:${signal.p}`,
        `a=fingerprint:${fingerprint}`,
        `a=setup:${signal.s}`,
        `a=mid:${mid}`,
        // No header extensions here: their ids differ between engines, and an
        // answer that maps an id differently from the real offer is rejected
        // by Chromium ("Failed to set recv parameters").
        "a=sendrecv",
        `a=msid:stream video0`,
        "a=rtcp-mux",
        "a=rtcp-rsize",
        "a=rtpmap:96 VP8/90000",
        "a=rtcp-fb:96 ccm fir",
        "a=rtcp-fb:96 nack",
        "a=rtcp-fb:96 nack pli",
        "a=rtcp-fb:96 goog-remb",
        `a=ssrc:${videoSsrc} cname:pkarr`,
        `a=ssrc:${videoSsrc} msid:stream video0`,
      );
    }
  });

  return lines.join("\r\n") + "\r\n";
}

/** How long to keep collecting after the candidate we were waiting for showed up. */
const ICE_SETTLE_MS = 400;

/**
 * Resolves when the local description is good enough to publish. Waiting for
 * gathering to *complete* takes the full timeout whenever one STUN server or
 * address family does not answer, which made every call ring ~10 s late. The
 * signal only carries a host and a server reflexive candidate anyway (plus a
 * relay one when TURN is configured), so that is what is waited for.
 */
export function waitForIceGathering(
  pc: RTCPeerConnection,
  timeoutMs = 10000,
): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") {
      resolve();
      return;
    }

    const usesTurn = (pc.getConfiguration().iceServers ?? []).some((server) =>
      [server.urls].flat().some((url) => url.startsWith("turn")),
    );
    const wanted = usesTurn ? " typ relay" : " typ srflx";
    let settle: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      clearTimeout(timeout);
      if (settle) clearTimeout(settle);
      pc.removeEventListener("icegatheringstatechange", onState);
      pc.removeEventListener("icecandidate", onCandidate);
      resolve();
    };
    const timeout = setTimeout(finish, timeoutMs);

    const onState = () => {
      if (pc.iceGatheringState === "complete") finish();
    };
    const onCandidate = (event: RTCPeerConnectionIceEvent) => {
      if (!settle && event.candidate?.candidate.includes(wanted)) settle = setTimeout(finish, ICE_SETTLE_MS);
    };

    pc.addEventListener("icegatheringstatechange", onState);
    pc.addEventListener("icecandidate", onCandidate);
  });
}

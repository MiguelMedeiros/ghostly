/**
 * Signaling for the WebRTC data link, carried in the `_rtc` record. It follows
 * the convention `_call` established: only what is unique to the session
 * travels through Pkarr and the SDP is rebuilt locally. The DTLS fingerprint
 * arrives inside a packet that is signed by the peer's key and encrypted with
 * the link key, which is what binds the WebRTC connection to the peer identity.
 */
export interface RtcSignal {
  t: "o" | "a";
  ts: number;
  /** For answers: `ts` of the offer being answered. */
  o?: number;
  /** ICE ufrag */
  u: string;
  /** ICE pwd */
  p: string;
  /** DTLS SHA-256 fingerprint, hex without separators */
  f: string;
  /** DTLS setup role */
  s: string;
  /** Candidates as `<h|s|r>,<address>,<port>` (host, server reflexive, relay) */
  c: string[];
}

export const DATA_CHANNEL_LABEL = "ghostly/1";
export const DATA_CHANNEL_ID = 0;
/** An offer older than this is ignored. */
export const RTC_SIGNAL_MAX_AGE_MS = 120_000;
/** A signal dated further ahead of this clock than this is not taken: its time would outrank every later one of its sender. */
export const RTC_SIGNAL_FUTURE_MS = 10 * 60_000;
/**
 * How this device saw a signal come. `since`: when its read of the maker's record that did not have the signal began,
 * by this clock; only a read the network answered counts, never a copy kept from before. `after`: the time of the
 * maker's own packet that read found, by the maker's clock; null when that read found none of the maker's.
 */
export interface SignalSight { since: number; after: number | null; live?: boolean }
/**
 * Whether an offer its maker dated `ts` is recent enough to answer.
 *
 * With a `sight`, two things place it in time without holding the maker's clock against this one. It was not in the
 * maker's record at `since`, so it reached the record after that; and it is not dated before the maker's packet that
 * was there (`after`, the same clock as `ts`), so it was not made before that packet either. An offer made earlier and
 * put in the record again later fails the second. Its time is then held between `since` and now, and only this clock
 * measures its age.
 *
 * When that read found nothing of the maker's (`after` null: a first contact), there is no packet to hold the offer
 * against, and a record that looked empty a moment ago is weaker ground: the offer's own time then has to be within
 * `RTC_SIGNAL_FUTURE_MS` of this clock too, which is as far as two clocks are taken to differ.
 *
 * Without a sight (the first read of a run found the offer) its own time is all there is to go by, and it may differ
 * from this clock by the age allowed, either way.
 */
export function offerIsFresh(ts: number, sight?: SignalSight, now = Date.now()): boolean {
  if (!sight) return Math.abs(now - ts) <= RTC_SIGNAL_MAX_AGE_MS;
  if (!sight.live && sight.after !== null && ts < sight.after) return false;
  if (!sight.live && sight.after === null && Math.abs(now - ts) > RTC_SIGNAL_FUTURE_MS) return false;
  return now - Math.max(sight.since, Math.min(ts, now)) <= RTC_SIGNAL_MAX_AGE_MS;
}
const MAX_MESSAGE_SIZE = 262_144;

const CANDIDATE_TYPES = { host: "h", srflx: "s", relay: "r" } as const;
const CANDIDATE_LIMITS: Record<string, number> = { h: 2, s: 2, r: 1 };
const CANDIDATE_PRIORITY: Record<string, number> = { h: 2122260223, s: 1686052607, r: 41885439 };
const CANDIDATE_TYPE_NAME: Record<string, string> = { h: "host", s: "srflx", r: "relay" };

export function extractRtcParams(sdp: string): Pick<RtcSignal, "u" | "p" | "f" | "s" | "c"> {
  let u = "";
  let p = "";
  let f = "";
  let s = "";
  const candidates: string[] = [];
  const counts: Record<string, number> = { h: 0, s: 0, r: 0 };

  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith("a=ice-ufrag:") && !u) u = line.slice("a=ice-ufrag:".length);
    else if (line.startsWith("a=ice-pwd:") && !p) p = line.slice("a=ice-pwd:".length);
    else if (line.toLowerCase().startsWith("a=fingerprint:sha-256 ") && !f) {
      f = line.slice("a=fingerprint:sha-256 ".length).replace(/:/g, "").toLowerCase();
    } else if (line.startsWith("a=setup:") && !s) s = line.slice("a=setup:".length);
    else if (line.startsWith("a=candidate:")) {
      // foundation component transport priority address port typ <type> ...
      const parts = line.slice("a=candidate:".length).split(" ");
      if (parts.length < 8 || parts[1] !== "1" || parts[2].toLowerCase() !== "udp") continue;
      const type = CANDIDATE_TYPES[parts[7] as keyof typeof CANDIDATE_TYPES];
      if (!type || counts[type] >= CANDIDATE_LIMITS[type]) continue;
      const compact = `${type},${parts[4]},${parts[5]}`;
      if (candidates.includes(compact)) continue;
      counts[type]++;
      candidates.push(compact);
    }
  }
  return { u, p, f, s, c: candidates };
}

const SAFE_TOKEN = /^[A-Za-z0-9+/=_-]{1,256}$/;
const SAFE_ADDRESS = /^[A-Za-z0-9.:-]{1,64}$/;

/** Validates an untrusted signal; anything that could inject SDP lines is rejected. */
export function parseRtcSignal(json: string): RtcSignal | null {
  let raw: Partial<RtcSignal>;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  if (raw.t !== "o" && raw.t !== "a") return null;
  if (typeof raw.ts !== "number" || !Number.isFinite(raw.ts)) return null;
  if (raw.o !== undefined && typeof raw.o !== "number") return null;
  if (typeof raw.u !== "string" || !SAFE_TOKEN.test(raw.u)) return null;
  if (typeof raw.p !== "string" || !SAFE_TOKEN.test(raw.p)) return null;
  if (typeof raw.f !== "string" || !/^[0-9a-fA-F]{64}$/.test(raw.f)) return null;
  if (raw.s !== "actpass" && raw.s !== "active" && raw.s !== "passive") return null;
  if (!Array.isArray(raw.c) || raw.c.length > 8) return null;
  for (const c of raw.c) {
    if (typeof c !== "string") return null;
    const [type, address, port] = c.split(",");
    if (!CANDIDATE_TYPE_NAME[type] || !SAFE_ADDRESS.test(address ?? "") || !/^\d{1,5}$/.test(port ?? "")) {
      return null;
    }
  }
  return { t: raw.t, ts: raw.ts, o: raw.o, u: raw.u, p: raw.p, f: raw.f, s: raw.s, c: raw.c };
}

export function buildDataSdp(signal: RtcSignal): string {
  const fingerprint = signal.f.toUpperCase().match(/.{2}/g)!.join(":");
  const sessionId = Math.floor(Math.random() * 1e15);

  const lines = [
    "v=0",
    `o=- ${sessionId} 2 IN IP4 127.0.0.1`,
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0",
    "a=msid-semantic: WMS",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
  ];
  signal.c.forEach((c, index) => {
    const [type, address, port] = c.split(",");
    const priority = CANDIDATE_PRIORITY[type] - index;
    let line = `a=candidate:${index + 1} 1 udp ${priority} ${address} ${port} typ ${CANDIDATE_TYPE_NAME[type]}`;
    if (type !== "h") line += " raddr 0.0.0.0 rport 0";
    lines.push(line);
  });
  lines.push(
    "a=end-of-candidates",
    `a=ice-ufrag:${signal.u}`,
    `a=ice-pwd:${signal.p}`,
    `a=fingerprint:sha-256 ${fingerprint}`,
    `a=setup:${signal.s}`,
    "a=mid:0",
    "a=sctp-port:5000",
    `a=max-message-size:${MAX_MESSAGE_SIZE}`,
  );
  return lines.join("\r\n") + "\r\n";
}

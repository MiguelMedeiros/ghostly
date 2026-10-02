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
/** Offers and answers older than this are ignored. */
export const RTC_SIGNAL_MAX_AGE_MS = 120_000;
const MAX_MESSAGE_SIZE = 262_144;

const CANDIDATE_TYPES = { host: "h", srflx: "s", relay: "r" } as const;
const CANDIDATE_LIMITS: Record<string, number> = { h: 2, s: 2, r: 1 };
const CANDIDATE_PRIORITY: Record<string, number> = { h: 2122260223, s: 1686052607, r: 41885439 };
const CANDIDATE_TYPE_NAME: Record<string, string> = { h: "host", s: "srflx", r: "relay" };

/**
 * The signal carries two host candidates, and a computer often has more interfaces than that: Wi-Fi, Ethernet, VM
 * bridges, Tailscale, a VPN. The browser lists them in its own order, and the first two are not always ones the
 * contact can reach: on a Mac with two VM bridges they are the bridges (addresses that exist on that Mac only), and
 * the Wi-Fi and Ethernet addresses never left it, so a contact on the same network was reached only if the router
 * sends a packet for its own public address back in (2026-10-02). So host candidates go in this order of preference:
 * those a server reflexive candidate was gathered from (`raddr`: an interface with a way out, the network a contact
 * nearby shares), then the others, and in each case those the browser marks as costly last (`network-cost` 50 or
 * more: a VPN, or an interface it does not know), as a call's candidates do (`pickCallCandidates`). With no
 * reflexive candidate, or none that says where it came from, the order is the browser's, as before.
 */
function hostRank(parts: string[], reflexiveBases: ReadonlySet<string>): number {
  const cost = Number(parts[parts.indexOf("network-cost") + 1]);
  const costly = parts.includes("network-cost") && cost >= 50;
  return (costly ? 2 : 0) + (reflexiveBases.has(parts[4]) ? 0 : 1);
}

export function extractRtcParams(sdp: string): Pick<RtcSignal, "u" | "p" | "f" | "s" | "c"> {
  let u = "";
  let p = "";
  let f = "";
  let s = "";
  /** UDP component-1 candidates of a type the signal carries, in the SDP's order. */
  const found: { type: string; parts: string[]; compact: string }[] = [];
  const reflexiveBases = new Set<string>();

  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith("a=ice-ufrag:") && !u) u = line.slice("a=ice-ufrag:".length);
    else if (line.startsWith("a=ice-pwd:") && !p) p = line.slice("a=ice-pwd:".length);
    else if (line.toLowerCase().startsWith("a=fingerprint:sha-256 ") && !f) {
      f = line.slice("a=fingerprint:sha-256 ".length).replace(/:/g, "").toLowerCase();
    } else if (line.startsWith("a=setup:") && !s) s = line.slice("a=setup:".length);
    else if (line.startsWith("a=candidate:")) {
      // foundation component transport priority address port typ <type> [raddr <address> rport <port>] ...
      const parts = line.slice("a=candidate:".length).split(" ");
      if (parts.length < 8 || parts[1] !== "1" || parts[2].toLowerCase() !== "udp") continue;
      const type = CANDIDATE_TYPES[parts[7] as keyof typeof CANDIDATE_TYPES];
      if (!type) continue;
      const compact = `${type},${parts[4]},${parts[5]}`;
      if (found.some((c) => c.compact === compact)) continue;
      found.push({ type, parts, compact });
      // A browser that hides local addresses says `raddr 0.0.0.0`: nothing to match then.
      const base = type === "s" && parts.includes("raddr") ? parts[parts.indexOf("raddr") + 1] : undefined;
      if (base && base !== "0.0.0.0" && base !== "::") reflexiveBases.add(base);
    }
  }
  // The host candidates the signal has room for, by preference; every type then goes out in the SDP's order.
  const hosts = found.filter((c) => c.type === "h");
  const preferred = new Set(hosts.map((c, at) => ({ c, at, rank: hostRank(c.parts, reflexiveBases) }))
    .sort((a, b) => a.rank - b.rank || a.at - b.at).slice(0, CANDIDATE_LIMITS.h).map(({ c }) => c));
  const candidates: string[] = [];
  const counts: Record<string, number> = { h: 0, s: 0, r: 0 };
  for (const c of found) {
    if (c.type === "h" ? !preferred.has(c) : counts[c.type] >= CANDIDATE_LIMITS[c.type]) continue;
    counts[c.type]++;
    candidates.push(c.compact);
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

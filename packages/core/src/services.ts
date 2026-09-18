/**
 * Ephemeral services a peer offers while it is online. Chat, voice and video
 * are the services Ghostly always had; `http` exposes a local web application.
 * Unknown types are preserved so future services do not need a new protocol.
 */
export type BuiltinServiceType = "chat" | "voice" | "video" | "http";

export interface ServiceAd {
  /** Stable identifier, unique per peer. Remote peers address services by id only. */
  id: string;
  type: BuiltinServiceType | (string & {});
  name?: string;
  /** Wire protocol spoken over the data link, e.g. `ghostly-http/1`. */
  proto?: string;
  meta?: Record<string, string>;
}

export const SERVICES_VERSION = 1;
export const HTTP_SERVICE_PROTO = "ghostly-http/1";
export const MAX_SERVICES = 16;
const MAX_NAME_LENGTH = 48;
const MAX_META_ENTRIES = 8;
const MAX_META_LENGTH = 64;
const SERVICE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** What a peer that predates `_svc` offers implicitly. */
export const LEGACY_SERVICES: ServiceAd[] = [
  { id: "chat", type: "chat" },
  { id: "voice", type: "voice" },
  { id: "video", type: "video" },
];

export function isValidServiceId(id: string): boolean {
  return SERVICE_ID_PATTERN.test(id);
}

export function serviceIdFromName(name: string, taken: Iterable<string> = []): string {
  const used = new Set(taken);
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "service";
  let id = base;
  for (let n = 2; used.has(id) || LEGACY_SERVICES.some((s) => s.id === id); n++) id = `${base}-${n}`;
  return id;
}

interface WireService {
  i: string;
  t: string;
  n?: string;
  p?: string;
  m?: Record<string, string>;
}

interface WireServices {
  v: number;
  s: (string | WireService)[];
}

/** Compact JSON; a service whose id equals its type and has no metadata is a bare string. */
export function servicesToWire(services: ServiceAd[]): WireServices {
  return {
    v: SERVICES_VERSION,
    s: services.map((s) => {
      if (s.id === s.type && !s.name && !s.proto && !s.meta) return s.id;
      const out: WireService = { i: s.id, t: s.type };
      if (s.name) out.n = s.name;
      if (s.proto) out.p = s.proto;
      if (s.meta && Object.keys(s.meta).length > 0) out.m = s.meta;
      return out;
    }),
  };
}

export function encodeServices(services: ServiceAd[]): string {
  return JSON.stringify(servicesToWire(services));
}

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  let clean = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 32 && code !== 127) clean += char;
  }
  clean = clean.trim();
  return clean ? clean.slice(0, max) : undefined;
}

/** Parses an untrusted advertisement. Invalid entries are dropped, never thrown. */
export function decodeServices(json: string): ServiceAd[] | null {
  let wire: unknown;
  try {
    wire = JSON.parse(json);
  } catch {
    return null;
  }
  return servicesFromWire(wire);
}

export function servicesFromWire(wire: unknown): ServiceAd[] | null {
  if (!wire || typeof wire !== "object") return null;
  const { v, s } = wire as Partial<WireServices>;
  if (typeof v !== "number" || v < 1 || !Array.isArray(s)) return null;

  const services: ServiceAd[] = [];
  const seen = new Set<string>();
  for (const entry of s.slice(0, MAX_SERVICES)) {
    let ad: ServiceAd | null = null;
    if (typeof entry === "string") {
      ad = { id: entry, type: entry };
    } else if (entry && typeof entry === "object") {
      const e = entry as Partial<WireService>;
      if (typeof e.i === "string" && typeof e.t === "string") {
        ad = { id: e.i, type: e.t };
        const name = cleanString(e.n, MAX_NAME_LENGTH);
        const proto = cleanString(e.p, MAX_META_LENGTH);
        if (name) ad.name = name;
        if (proto) ad.proto = proto;
        if (e.m && typeof e.m === "object") {
          const meta: Record<string, string> = {};
          for (const [k, val] of Object.entries(e.m).slice(0, MAX_META_ENTRIES)) {
            const key = cleanString(k, MAX_META_LENGTH);
            const value = cleanString(val, MAX_META_LENGTH);
            if (key && value) meta[key] = value;
          }
          if (Object.keys(meta).length > 0) ad.meta = meta;
        }
      }
    }
    if (!ad || !isValidServiceId(ad.id) || !SERVICE_ID_PATTERN.test(ad.type) || seen.has(ad.id)) continue;
    seen.add(ad.id);
    services.push(ad);
  }
  return services;
}

import { linkEnd } from "@ghostly/core";

/**
 * A place in a message: a `geo:` URI (RFC 5870, and Android's `?q=` label) or a Google Maps, Apple Maps or
 * OpenStreetMap link that carries its coordinates. Read from the text alone: the reader's app asks nobody about
 * it. Short links (maps.app.goo.gl, osm.org/go) hide their coordinates and are left as links.
 */
export interface Place {
  lat: number;
  lon: number;
  /** A name the link gives the place ("Padrão dos Descobrimentos"), when it gives one. */
  name?: string;
  /** Map zoom the link asks for, if any (1-19). */
  zoom?: number;
  /** The text the place was read from (the `geo:` URI or the map link). */
  source: string;
}

const NUMBER = String.raw`[-+]?\d{1,3}(?:\.\d+)?`;
const PAIR = new RegExp(String.raw`^\s*(${NUMBER})\s*,\s*(${NUMBER})\s*$`);

function place(lat: string | number, lon: string | number, source: string, name?: string, zoom?: string | number): Place | null {
  const la = Number(lat), lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
  const z = Number(zoom);
  const cleanName = name?.replace(/\+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return {
    lat: la, lon: lo, source,
    ...(cleanName && !PAIR.test(cleanName) && { name: cleanName }),
    ...(Number.isFinite(z) && z >= 1 && z <= 19 && { zoom: Math.round(z) }),
  };
}

const decode = (text: string) => { try { return decodeURIComponent(text.replace(/\+/g, " ")); } catch { return text; } };

/** `geo:lat,lon[,alt][;params][?q=…]`: Android puts a label in `q` as `lat,lon(Label)` or as a plain name. */
function fromGeo(uri: string): Place | null {
  const match = /^geo:([^;?#]+)(?:;[^?#]*)?(?:\?([^#]*))?/i.exec(uri);
  if (!match) return null;
  const [lat, lon] = match[1].split(",");
  const query = new URLSearchParams(match[2] ?? "");
  const q = query.get("q") ?? "";
  const labelled = /^\s*(NUMBER),\s*(NUMBER)\s*\((.+)\)\s*$/.source.replace(/NUMBER/g, NUMBER);
  const label = new RegExp(labelled).exec(q);
  // `geo:0,0?q=Some+Place` is a search, not a place: nothing to draw.
  if (label) return place(label[1], label[2], uri, label[3], query.get("z") ?? undefined);
  if (Number(lat) === 0 && Number(lon) === 0) return null;
  return place(lat, lon, uri, q && !PAIR.test(q) ? q : undefined, query.get("z") ?? undefined);
}

function fromMapLink(link: string): Place | null {
  let url: URL;
  try { url = new URL(link); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const q = url.searchParams;
  const pair = (value: string | null) => value ? PAIR.exec(value) : null;

  if (/^(google\.[a-z.]+|maps\.google\.[a-z.]+)$/.test(host) && (host.startsWith("maps.") || url.pathname.startsWith("/maps"))) {
    // /maps/place/<Name>/@lat,lon,17z/…  ·  /maps/@lat,lon,15z  ·  ?q=lat,lon  ·  /maps/search/?api=1&query=lat,lon
    const at = new RegExp(String.raw`/@(${NUMBER}),(${NUMBER})(?:,(\d{1,2}(?:\.\d+)?)z)?`).exec(url.pathname);
    const name = /\/maps\/place\/([^/@]+)/.exec(url.pathname)?.[1];
    if (at) return place(at[1], at[2], link, name && decode(name), at[3]);
    const query = pair(q.get("q")) ?? pair(q.get("query")) ?? pair(q.get("ll")) ?? pair(q.get("center"));
    if (query) return place(query[1], query[2], link, undefined, q.get("z") ?? q.get("zoom") ?? undefined);
    return null;
  }
  if (host === "maps.apple.com" || host === "maps.apple") {
    // ?ll=lat,lon&q=Name  ·  /place?coordinate=lat,lon&name=Name  ·  ?q=lat,lon
    const ll = pair(q.get("ll")) ?? pair(q.get("coordinate")) ?? pair(q.get("sll")) ?? pair(q.get("q"));
    const name = q.get("name") ?? (pair(q.get("q")) ? undefined : q.get("q") ?? undefined);
    return ll ? place(ll[1], ll[2], link, name ?? undefined, q.get("z") ?? undefined) : null;
  }
  if (host === "openstreetmap.org" || host === "osm.org") {
    // ?mlat=…&mlon=…#map=zoom/lat/lon  ·  #map=zoom/lat/lon
    const map = new RegExp(String.raw`map=(\d{1,2})/(${NUMBER})/(${NUMBER})`).exec(url.hash);
    const mlat = q.get("mlat"), mlon = q.get("mlon");
    if (mlat && mlon) return place(mlat, mlon, link, undefined, map?.[1]);
    if (map) return place(map[2], map[3], link, undefined, map[1]);
    return null;
  }
  return null;
}

/** The place a single link or `geo:` URI names, or null. */
export function findLocation(link: string): Place | null {
  return /^geo:/i.test(link) ? fromGeo(link) : fromMapLink(link);
}

/** The first place a message's text names: a `geo:` URI or a map link, in the order they appear. */
export function locationIn(text: string): Place | null {
  for (const match of text.matchAll(/\bgeo:[^\s<>"']+|https?:\/\/\S+/gi)) {
    // Ends as a link does: sentence punctuation and an unopened bracket stay text; Android's `(Label)` stays in.
    const found = findLocation(linkEnd(match[0]));
    if (found) return found;
  }
  return null;
}

/** Degrees as the card shows them: five decimals (about a metre). */
export const formatCoordinates = ({ lat, lon }: Pick<Place, "lat" | "lon">) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

/** The OpenStreetMap page of a place: the link that opens it where no maps app takes it. */
export function openStreetMapUrl({ lat, lon, zoom }: Pick<Place, "lat" | "lon" | "zoom">): string {
  const z = zoom ?? 16;
  return `https://www.openstreetmap.org/?mlat=${lat.toFixed(6)}&mlon=${lon.toFixed(6)}#map=${z}/${lat.toFixed(6)}/${lon.toFixed(6)}`;
}

/**
 * Where "Open in maps" goes. On Apple systems, an Apple Maps link opens the Maps app; on Android a `geo:` URI opens
 * whichever maps app the person chose; elsewhere the place opens on OpenStreetMap in the browser.
 */
export function mapsUrl(where: Place, platform: "apple" | "android" | "other"): string {
  const { lat, lon, name } = where;
  if (platform === "apple") return `https://maps.apple.com/?ll=${lat},${lon}${name ? `&q=${encodeURIComponent(name)}` : ""}`;
  if (platform === "android") return `geo:${lat},${lon}?q=${lat},${lon}${name ? `(${encodeURIComponent(name)})` : ""}`;
  return openStreetMapUrl(where);
}

/**
 * The OpenStreetMap tiles (256 px, Web Mercator) that show a place, and where the place falls on them: the 2×2
 * block whose middle is nearest the point, so the point is never at an edge. Nothing loads until they are drawn.
 */
export function mapTiles({ lat, lon }: Pick<Place, "lat" | "lon">, zoom = 15) {
  const n = 2 ** zoom;
  const x = (lon + 180) / 360 * n;
  const rad = Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n;
  const x0 = Math.min(n - 2, Math.max(0, Math.round(x) - 1)), y0 = Math.min(n - 2, Math.max(0, Math.round(y) - 1));
  const tiles = [0, 1].flatMap(dy => [0, 1].map(dx => ({
    dx, dy, src: `https://tile.openstreetmap.org/${zoom}/${x0 + dx}/${y0 + dy}.png`,
  })));
  return { tiles, point: { x: (x - x0) * 256, y: (y - y0) * 256 } };
}

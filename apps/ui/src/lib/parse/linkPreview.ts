import { canonicalUrl, linksIn } from "@ghostly/core";
import { findEntities } from "./entities";
import { findLocation } from "./location";

/**
 * What a page says about itself, read by the sender's app for a link preview (WISP 401 § Link previews): Open
 * Graph and Twitter card tags, the plain `<title>` and description, or an oEmbed answer. Nothing here fetches; the
 * page's HTML is scanned as text (never parsed into a document, never rendered) and only its head is read.
 */
export interface PageMeta {
  title?: string;
  description?: string;
  site?: string;
  /** Absolute http(s) address of the page's picture. */
  image?: string;
}

/** The part of a page its tags are in. Pages with a huge inline head are cut here. */
const HEAD_CHARS = 512 * 1024;

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "\u2013", mdash: "\u2014", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", middot: "·", copy: "©", reg: "®", trade: "™" };

/** HTML character references in an attribute or a title. Unknown names stay as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
    }
    return NAMED[ref.toLowerCase()] ?? whole;
  });
}

/** A tag's attributes, names lowercased. */
function attributes(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of tag.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = match[1].toLowerCase();
    if (!out.has(name)) out.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return out;
}

/** An http(s) address as the page meant it (relative to where it was read), or undefined. */
function absolute(value: string | undefined, base: string): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value.trim(), base);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch { return; }
}

const tidy = (value: string | undefined) => value?.replace(/\s+/g, " ").trim() || undefined;

/** A page's own description of itself: Open Graph first, then Twitter card tags, then plain HTML. */
export function parseOpenGraph(html: string, pageUrl: string): PageMeta {
  let head = html.slice(0, HEAD_CHARS);
  const end = head.search(/<\/head\s*>|<body[\s>]/i);
  if (end >= 0) head = head.slice(0, end);
  // Comments and scripts may hold text that looks like tags.
  head = head.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, "");
  const meta = new Map<string, string>();
  for (const match of head.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = attributes(match[1]);
    const key = (attrs.get("property") ?? attrs.get("name") ?? attrs.get("itemprop"))?.toLowerCase().trim();
    const content = attrs.get("content");
    if (key && content !== undefined && !meta.has(key)) meta.set(key, content);
  }
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head)?.[1];
  const first = (...keys: string[]) => keys.map(k => tidy(meta.get(k))).find(Boolean);
  return {
    title: first("og:title", "twitter:title") ?? tidy(title && decodeEntities(title)),
    description: first("og:description", "twitter:description", "description"),
    site: first("og:site_name", "application-name"),
    image: absolute(first("og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src", "image"), pageUrl),
  };
}

/** An oEmbed answer (https://oembed.com): its title, the provider as the site, the thumbnail as the picture. */
export function parseOEmbed(answer: unknown, endpoint: string): PageMeta {
  if (!answer || typeof answer !== "object") return {};
  const value = answer as Record<string, unknown>;
  const text = (key: string) => typeof value[key] === "string" ? tidy(value[key] as string) : undefined;
  const author = text("author_name");
  return {
    title: text("title"),
    description: author ? `by ${author}` : undefined,
    site: text("provider_name"),
    image: absolute(text("thumbnail_url"), endpoint),
  };
}

/** A video on a site whose card Ghostly draws as a video: tapping opens the site, nothing is embedded. */
export type VideoSite = "youtube" | "vimeo";

export function videoSite(url: string): VideoSite | null {
  let host: string, path: string;
  try { ({ hostname: host, pathname: path } = new URL(url)); } catch { return null; }
  host = host.replace(/^(www\.|m\.|music\.)/, "");
  if ((host === "youtube.com" && /^\/(watch|shorts\/|live\/|embed\/)/.test(path)) || (host === "youtu.be" && path.length > 1)) return "youtube";
  if ((host === "vimeo.com" || host === "player.vimeo.com") && /\/\d+/.test(path)) return "vimeo";
  return null;
}

/**
 * The provider's own oEmbed endpoint for a link, for the sites whose pages say little to a plain request. Only
 * these fixed endpoints are ever asked; a page's own oEmbed discovery is not followed.
 */
export function oEmbedEndpoint(url: string): string | null {
  switch (videoSite(url)) {
    case "youtube": return `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`;
    case "vimeo": return `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`;
    default: return null;
  }
}

/**
 * A host that names this machine or the local network, as far as its spelling tells: `localhost`, `.local`,
 * `.internal`, a single label, private and reserved IP addresses. Previews are never made for these, and a page
 * on the internet may not point its picture at one. (Desktop also checks the addresses a name resolves to.)
 */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!host.includes(".") && !host.includes(":")) return true;
  if (/(^|\.)(localhost|local|internal|lan|home\.arpa)$/.test(host)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b < 128) || (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0);
  }
  // Any IPv6 literal but a global unicast one (2000::/3), and none that embeds an IPv4 address.
  if (host.includes(":")) return !/^[23][0-9a-f]{0,3}:/.test(host) || host.includes(".") || /^2001:0?db8:/.test(host);
  return false;
}

const IMAGE_LINK = /\.(gif|png|jpe?g|webp|svg|avif)(\?\S*)?$/i;

/**
 * The link of a text a preview would be made for: the first http(s) link that is not a picture (those show
 * themselves), a place (the location card draws those, and asks nothing) or a Ghostly invite or group link (their
 * card comes from the code, and the page says nothing more), on a public host. Null when none.
 */
export function previewableLink(text: string): string | null {
  for (const link of linksIn(text)) {
    const canonical = canonicalUrl(link);
    if (!canonical) continue;
    const url = new URL(canonical);
    if (IMAGE_LINK.test(url.pathname) || isLocalHost(url.hostname) || findLocation(link) || findEntities(link).length) continue;
    // A link still being typed ("https://exam") has no dot in its host yet, or a one-letter top-level name.
    if (!/\.[a-z]{2,}$/i.test(url.hostname) && !/^[\d.]+$/.test(url.hostname)) continue;
    return link;
  }
  return null;
}

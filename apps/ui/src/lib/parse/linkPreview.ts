import { canonicalUrl, linksIn, type LinkPreview } from "@ghostly/core";
import { isLocalHost } from "../localHost";
import { parseMessage } from "./blocks";
import { findEntities } from "./entities";
import { linkEnd } from "./links";
import { findLocation } from "./location";
import type { Block, Segment } from "./types";

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

export { isLocalHost };

const IMAGE_LINK = /\.(gif|png|jpe?g|webp|svg|avif)(\?\S*)?$/i;

/**
 * The link of a text a preview would be made for: the first http(s) link that is not a picture (those show
 * themselves), a place (the location card draws those, and asks nothing) or a Ghostly invite or group link (their
 * card comes from the code, and the page says nothing more), on a public host, and one the bubble draws as a link with
 * that same address, outside a spoiler: none in code, and none a card would read longer or shorter than the bubble
 * opens it ("~~https://a.example/x~~", "[DC](https://…/Washington,_D.C.)"), or the card would open another page.
 * Not one a spoiler hides either (its card would say what the spoiler covers). Null when none.
 */
export function previewableLink(text: string): string | null {
  // Read only once a link could get a card: the composer asks on every key, of drafts that may be long.
  let drawn: Set<string> | undefined;
  for (const link of linksIn(text)) {
    const canonical = canonicalUrl(link);
    if (!canonical) continue;
    const url = new URL(canonical);
    if (IMAGE_LINK.test(url.pathname) || isLocalHost(url.hostname) || findLocation(link) || findEntities(link).length) continue;
    // A link still being typed ("https://exam") has no dot in its host yet, or a one-letter top-level name.
    if (!/\.[a-z]{2,}$/i.test(url.hostname) && !/^[\d.]+$/.test(url.hostname)) continue;
    if (!(drawn ??= bubbleLinks(text).shown).has(link)) continue;
    return link;
  }
  return null;
}

/**
 * The links the bubble draws in `text`, by the address each opens: those it shows outside a spoiler (`shown`), and
 * those only inside one, or as a link whose words hold one (`hidden`). Code is never read for links.
 */
function bubbleLinks(text: string): { shown: Set<string>; hidden: Set<string> } {
  const shown = new Set<string>(), hidden = new Set<string>();
  const walk = (segments: Segment[], covered: boolean) => {
    for (const segment of segments) {
      if (segment.type === "span") walk(segment.children, covered || segment.style === "spoiler");
      else if (segment.type === "atom" && (segment.kind === "link" || segment.kind === "md-link")) {
        const { url, label } = segment.data as { url: string; label?: Segment[] };
        (covered || (label && hasSpoiler(label)) ? hidden : shown).add(url);
      }
    }
  };
  const block = (b: Block): void => {
    if (b.type === "paragraph" || b.type === "heading") walk(b.segments, false);
    else if (b.type === "quote") b.blocks.forEach(block);
    else if (b.type === "list") for (const item of b.items) { walk(item.segments, false); item.children.forEach(block); }
  };
  parseMessage(text).forEach(block);
  return { shown, hidden };
}

/**
 * Whether a link of `text` (as `linksIn` reads it) shows only inside a spoiler, or as a link whose words hold one: the
 * bubble keeps it covered, so no card may say where it goes. A link the text shows outside a spoiler as well is not.
 */
function spoiledLinks(text: string): (link: string) => boolean {
  if (!text.includes("||")) return () => false;
  const { shown, hidden } = bubbleLinks(text);
  // `linksIn` keeps a spoiler's closing "||" on its link; the bubble's link ends before it.
  return (link) => { const url = linkEnd(link); return hidden.has(url) && !shown.has(url); };
}

const hasSpoiler = (segments: Segment[]): boolean =>
  segments.some((s) => s.type === "span" && (s.style === "spoiler" || hasSpoiler(s.children)));

/** A received preview, unless its link shows only inside a spoiler (an older app makes one for it). */
export function shownPreview(text: string, preview: LinkPreview | undefined): LinkPreview | undefined {
  if (!preview) return undefined;
  const hidden = spoiledLinks(text);
  const links = linksIn(text).filter((link) => canonicalUrl(link) === preview.u);
  return links.length && links.every(hidden) ? undefined : preview;
}

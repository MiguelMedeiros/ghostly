import { jpegSize } from "./avatar";

/**
 * A link preview as it travels with a chat message (WISP 401 § Link previews): what the sender's app read from the
 * page when the message was written, carried in the message so the reader never contacts the site. Every field
 * but the link is optional. The receiver checks it here and drops it, never the message, when anything is off.
 */
export interface LinkPreview {
  /** The link the preview is of: a link of the message's text, without its tracking parameters (`canonicalUrl`). */
  u: string;
  /** The page's title. */
  t?: string;
  /** Its description. */
  d?: string;
  /** The site's name ("YouTube"). */
  s?: string;
  /** A thumbnail redrawn by the sender: a JPEG `data:` URL (`LINK_PREVIEW_LIMITS.imageBytes`, `imageSide`). */
  i?: string;
}

export const LINK_PREVIEW_LIMITS = {
  urlChars: 2048,
  titleChars: 200,
  descriptionChars: 300,
  siteChars: 80,
  /** The thumbnail's JPEG bytes. Ghostly draws it at most 320 pixels wide and fits it under this. */
  imageBytes: 20_000,
  /** The largest side a thumbnail may declare in its header (a tiny file can claim a huge image). */
  imageSide: 640,
  /** The preview as JSON. With a text of 16 KiB the message frame stays under the 60 KiB a session takes. */
  jsonChars: 30 * 1024,
} as const;

const JPEG_PREFIX = "data:image/jpeg;base64,";

/**
 * Query parameters that only say where a click came from. They are dropped from a previewed link, and the card
 * shows and opens the link without them.
 */
const TRACKING_PARAMS = new Set([
  "fbclid", "gclid", "dclid", "gbraid", "wbraid", "msclkid", "yclid", "twclid", "ttclid", "li_fat_id", "igshid", "igsh",
  "mc_cid", "mc_eid", "_hsenc", "_hsmi", "mkt_tok", "oly_anon_id", "oly_enc_id", "vero_id", "rb_clickid", "srsltid",
  "ref_src", "ref_url", "si", "__s", "s_cid", "spm",
]);
const isTracking = (name: string) => /^utm_/i.test(name) || TRACKING_PARAMS.has(name.toLowerCase());

/**
 * A link ends where the sentence around it takes over: trailing punctuation ("see https://x.example/a.") and a
 * closing bracket or quote the link did not open ("(https://x.example/a)") are left as text. The same rule as the
 * message bubble's links.
 */
export function linkEnd(url: string): string {
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (;;) {
    const last = url[url.length - 1];
    const opener = pairs[last];
    const count = (c: string) => url.split(c).length - 1;
    if (/[.,;:!?'"*_>]/.test(last) || (opener && count(last) > count(opener))) url = url.slice(0, -1);
    else return url;
  }
}

/** The http(s) links of a text, in order, each ending as the bubble ends it. */
export function linksIn(text: string): string[] {
  return [...text.matchAll(/https?:\/\/\S+/g)].map(match => linkEnd(match[0])).filter(url => url.length > 8);
}

/**
 * The link as a preview names it: parsed, http(s) only, without tracking parameters (`utm_*`, `fbclid`, …). The
 * other parameters keep their order and spelling. Null for anything that is not an http(s) URL.
 */
export function canonicalUrl(link: string): string | null {
  if (link.length > LINK_PREVIEW_LIMITS.urlChars * 2) return null;
  let url: URL;
  try { url = new URL(link); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const kept = url.search.slice(1).split("&").filter(pair => {
    if (!pair) return false;
    const name = pair.split("=")[0];
    let decoded = name;
    try { decoded = decodeURIComponent(name.replace(/\+/g, " ")); } catch { /* the name as written */ }
    return !isTracking(decoded);
  });
  url.search = kept.length ? `?${kept.join("&")}` : "";
  const out = url.href;
  return out.length <= LINK_PREVIEW_LIMITS.urlChars ? out : null;
}

/** Text as a preview carries it: one line, control characters out, cut at `max` characters. */
function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** The thumbnail if it is one Ghostly shows: a JPEG data URL within the limits whose header declares a sane size. */
export function sanitizePreviewImage(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith(JPEG_PREFIX)) return;
  const data = value.slice(JPEG_PREFIX.length);
  if (data.length > Math.ceil(LINK_PREVIEW_LIMITS.imageBytes / 3) * 4 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return;
  let binary: string;
  try { binary = atob(data); } catch { return; }
  if (binary.length > LINK_PREVIEW_LIMITS.imageBytes) return;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const size = jpegSize(bytes);
  const side = LINK_PREVIEW_LIMITS.imageSide;
  if (!size || size.width < 1 || size.height < 1 || size.width > side || size.height > side) return;
  return value;
}

/**
 * A preview as a message may carry it, or undefined. `text` is the message's: the preview must be of one of its
 * links (compared without tracking parameters), so a card can never point somewhere the text does not. Titles and
 * descriptions are cut to their limits; a bad thumbnail is dropped and the rest kept.
 */
export function parseLinkPreview(raw: unknown, text: string): LinkPreview | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const value = raw as Record<string, unknown>;
  if (typeof value.u !== "string") return;
  const u = canonicalUrl(value.u);
  if (!u || !linksIn(text).some(link => canonicalUrl(link) === u)) return;
  const preview: LinkPreview = { u };
  const t = clip(value.t, LINK_PREVIEW_LIMITS.titleChars), d = clip(value.d, LINK_PREVIEW_LIMITS.descriptionChars);
  const s = clip(value.s, LINK_PREVIEW_LIMITS.siteChars), i = sanitizePreviewImage(value.i);
  if (t) preview.t = t;
  if (d) preview.d = d;
  if (s) preview.s = s;
  if (i) preview.i = i;
  // A card with nothing but the link says no more than the link does.
  if (!t && !d && !i) return;
  if (JSON.stringify(preview).length > LINK_PREVIEW_LIMITS.jsonChars) return;
  return preview;
}

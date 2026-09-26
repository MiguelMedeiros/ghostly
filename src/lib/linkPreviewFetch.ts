import { invoke } from "@tauri-apps/api/core";
import { LINK_PREVIEW_LIMITS, canonicalUrl, parseLinkPreview, sanitizePreviewImage, type LinkPreview } from "@ghostly/core";
import { isLocalHost, oEmbedEndpoint, parseOEmbed, parseOpenGraph, type PageMeta } from "./parse/linkPreview";

/**
 * Link previews on the sender's side (WISP 401 § Link previews): the page a link points to is read by this app, its
 * picture redrawn here as a small JPEG, and the result goes with the message. The reader's app never asks the site.
 *
 * Desktop reads through Rust (`link_preview_fetch`): no CORS, and every address checked to be public. The web app
 * and the extension can only read sites that allow it (CORS); for the rest there is simply no preview. Ghostly runs
 * no proxy for this: a proxy would learn every link everyone previews.
 */

type Kind = "page" | "json" | "image";
interface Answer { url: string; contentType: string; body: Uint8Array }

const TIMEOUT_MS = 10_000;
const MAX_BYTES: Record<Kind, number> = { page: 768 * 1024, json: 64 * 1024, image: 5 * 1024 * 1024 };
/** The thumbnail's widest side as drawn: small in the card, sharp enough on a phone. */
const THUMB_SIDE = 320;

const desktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function viaDesktop(url: string, kind: Kind): Promise<Answer> {
  const answer = await invoke<{ url: string; contentType: string; bodyB64: string }>("link_preview_fetch", { url, kind });
  return { url: answer.url, contentType: answer.contentType, body: fromBase64(answer.bodyB64) };
}

/** A browser can read another site only if that site allows it; no cookies, no referrer, and never too much. */
async function viaBrowser(url: string, kind: Kind, signal: AbortSignal): Promise<Answer> {
  const response = await fetch(url, { mode: "cors", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", redirect: "follow", signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.length > MAX_BYTES[kind]) {
      if (kind !== "page") { void reader.cancel(); throw new Error("Too large"); }
      chunks.push(value.slice(0, MAX_BYTES[kind] - size));
      void reader.cancel();
      break;
    }
    chunks.push(value);
    size += value.length;
  }
  const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) { body.set(chunk, at); at += chunk.length; }
  return { url: response.url || url, contentType: response.headers.get("content-type") ?? "", body };
}

async function get(url: string, kind: Kind, signal: AbortSignal): Promise<Answer> {
  const answer = desktop() ? await viaDesktop(url, kind) : await viaBrowser(url, kind, signal);
  // A redirect may not take a public link to this machine or the local network.
  if (isLocalHost(new URL(answer.url).hostname)) throw new Error("Local address");
  return answer;
}

/** A page's text in its own encoding: the Content-Type's charset, else a `<meta charset>` near the top, else UTF-8. */
export function decodePage(body: Uint8Array, contentType: string): string {
  const declared = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1]
    ?? /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(new TextDecoder("latin1").decode(body.slice(0, 2048)))?.[1];
  try { return new TextDecoder(declared ?? "utf-8").decode(body); } catch { return new TextDecoder().decode(body); }
}

/**
 * A picture redrawn as what a preview carries: at most 320 pixels wide (and tall), on white, as a fresh JPEG under
 * the byte cap. Redrawing keeps the pixels only; nothing else of the file travels. Undefined when it cannot be made.
 */
export async function thumbnailFrom(blob: Blob): Promise<string | undefined> {
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(blob); } catch { return; }
  try {
    if (bitmap.width < 16 || bitmap.height < 16) return;
    for (const side of [THUMB_SIDE, 240, 160]) {
      const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.78, 0.65, 0.5]) {
        const url = canvas.toDataURL("image/jpeg", quality);
        if (sanitizePreviewImage(url)) return url;
      }
    }
  } finally {
    bitmap.close();
  }
}

async function readMeta(link: string, signal: AbortSignal): Promise<PageMeta | null> {
  const endpoint = oEmbedEndpoint(link);
  if (endpoint) {
    try {
      const answer = await get(endpoint, "json", signal);
      const meta = parseOEmbed(JSON.parse(new TextDecoder().decode(answer.body)), answer.url);
      if (meta.title) return meta;
    } catch { /* the page itself, then */ }
  }
  const page = await get(link, "page", signal);
  if (page.contentType && !/html|xml/i.test(page.contentType)) return null;
  return parseOpenGraph(decodePage(page.body, page.contentType), page.url);
}

/** Makes the preview of one link, or null when there is none to make. Never throws. */
export async function makeLinkPreview(link: string, signal: AbortSignal): Promise<LinkPreview | null> {
  const u = canonicalUrl(link);
  if (!u || isLocalHost(new URL(u).hostname)) return null;
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const both = AbortSignal.any ? AbortSignal.any([signal, timeout]) : signal;
  try {
    const meta = await readMeta(u, both);
    if (!meta || both.aborted) return null;
    let i: string | undefined;
    if (meta.image && !isLocalHost(new URL(meta.image).hostname)) {
      try {
        const picture = await get(meta.image, "image", both);
        if (/^image\/(jpeg|png|webp|gif)/i.test(picture.contentType) || !picture.contentType)
          i = await thumbnailFrom(new Blob([picture.body as BlobPart], { type: picture.contentType || "image/jpeg" }));
      } catch { /* a preview without a picture */ }
    }
    if (both.aborted) return null;
    const preview = parseLinkPreview({ u, t: meta.title, d: meta.description, s: meta.site, i }, link);
    return preview && JSON.stringify(preview).length <= LINK_PREVIEW_LIMITS.jsonChars ? preview : null;
  } catch {
    return null;
  }
}

/** Previews made this session, so a link typed again (or the same draft) asks nothing twice. */
const made = new Map<string, Promise<LinkPreview | null>>();
const KEPT = 40;

export function linkPreviewFor(link: string): Promise<LinkPreview | null> {
  const key = canonicalUrl(link) ?? link;
  const known = made.get(key);
  if (known) return known;
  // Not cancelled when the draft changes: the request is out already, and its answer serves the next time.
  const pending = makeLinkPreview(link, new AbortController().signal);
  made.set(key, pending);
  while (made.size > KEPT) made.delete(made.keys().next().value!);
  // A failure is not kept: the site may answer next time.
  void pending.then(preview => { if (!preview) made.delete(key); });
  return pending;
}

/** Forgets what was made (tests). */
export function forgetLinkPreviews(): void { made.clear(); }

/**
 * Files pasted or dropped into a chat: what of a paste or a drop is sent as files, and the name a
 * pasted image gets. Text stays text: a paste with no files is left to the field, and so is a rich
 * copy (a spreadsheet's cells, a document's paragraph) that carries a picture of itself beside its
 * text and HTML.
 */
import { IMAGE_LIMITS, imageSize, previewable } from "@ghostly/core";
import type { ClipboardFile, ClipboardFiles } from "@ghostly/browser/host";
import { servicesPlatform } from "./platform";

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp",
  "image/tiff": "tiff", "image/heic": "heic", "image/heif": "heif", "image/avif": "avif", "image/svg+xml": "svg",
};

/** Types by extension, for files the platform read (a browser's File already has one). */
const TYPES: Record<string, string> = {
  ...Object.fromEntries(Object.entries(IMAGE_EXTENSIONS).map(([type, ext]) => [ext, type])), jpeg: "image/jpeg", tif: "image/tiff",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", zip: "application/zip",
  mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", opus: "audio/ogg", wav: "audio/wav", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
};

/** The most a paste read by the platform brings into the page, all its files together: more goes through + → Document. */
export const PLATFORM_PASTE_MAX = 256 * 1024 * 1024;
/** The most files a paste or a drop read by the platform brings (the desktop app's `MAX_PASTED_FILES`). */
export const PLATFORM_PASTE_FILES = 32;
/** How many names of files left out a line says; the rest is "…". */
const NAMES_SAID = 10;

/** File names for a line: the first few, then "…". */
export function someNames(names: string[]): string {
  return [...names.slice(0, NAMES_SAID), ...(names.length > NAMES_SAID ? ["…"] : [])].join(", ");
}
const READ_STEP = 16 * 1024 * 1024;
const TOO_LARGE_TO_PASTE = "That is too large to paste. Send it with + → Document.";

/** A name a browser gives an image that has none of its own ("image.png", or nothing). */
const GENERIC_IMAGE = /^(image\.\w+)?$/i;

const two = (n: number) => String(n).padStart(2, "0");

/** "Pasted image 2026-09-27 14.52.10.png", in local time, the way a screenshot is named. */
export function pastedImageName(type: string, at: Date = new Date()): string {
  const ext = IMAGE_EXTENSIONS[type] ?? (type.startsWith("image/") ? type.slice(6).replace(/[^a-z0-9]/gi, "") || "png" : "png");
  const day = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
  return `Pasted image ${day} ${two(at.getHours())}.${two(at.getMinutes())}.${two(at.getSeconds())}.${ext}`;
}

/** The files a transfer carries: `files`, or its items of kind "file" where `files` is left empty. */
function filesOf(data: DataTransfer): File[] {
  const files = [...(data.files ?? [])];
  if (files.length) return files;
  return [...(data.items ?? [])].filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter((file): file is File => !!file);
}

/**
 * What a paste sends as files, or null when it is text for the field (nothing to intercept). A
 * pasted image with a browser's placeholder name is named after the moment it was pasted; a
 * copied file keeps its own name.
 */
export function pastedFiles(data: DataTransfer | null, at: Date = new Date()): File[] | null {
  if (!data) return null;
  const files = filesOf(data);
  if (!files.length) return null;
  // A rich copy: its text is what was meant, the picture is how the app that copied it draws it.
  if (data.getData("text/plain").trim() && data.getData("text/html")) return null;
  return files.map((file) => file.type.startsWith("image/") && GENERIC_IMAGE.test(file.name)
    ? new File([file], pastedImageName(file.type, at), { type: file.type, lastModified: at.getTime() })
    : file);
}

/** What a drop sends: its files, under their own names. */
export function droppedFiles(data: DataTransfer | null): File[] {
  return data ? filesOf(data) : [];
}

/** Whether a drag carries files (not text or a link being dragged about). */
export function dragHasFiles(data: DataTransfer | null): boolean {
  return !!data && [...(data.types ?? [])].includes("Files");
}

/**
 * Whether a drag names what it carries by address only: a link, or files the webview does not hand
 * over (WebKitGTK shows a file manager's drag as `text/uri-list` with no files).
 */
function dragNamesAddress(data: DataTransfer | null): boolean {
  return !!data && [...(data.types ?? [])].includes("text/uri-list");
}

/**
 * Another app's drag of files that the webview names by address only, as the platform tells it (the desktop app on
 * Linux: WebKitGTK gives the page neither the files nor their addresses). The platform holds the files of its drop;
 * the page reads them by token, never by path.
 */
let platformDrag: { over: boolean; read: () => Promise<ClipboardFiles> } | null = null;

/**
 * The platform takes drops of files: `read` hands over the files of the drop that just happened. Returns what the
 * platform calls while such a drag is over the window (true) and once it left (false). The page forgets it once a
 * drop's handlers ran: the platform says nothing of a drop, which it could say before the page hears of it.
 */
export function followPlatformDrags(read: () => Promise<ClipboardFiles>, target: Window = window): (over: boolean) => void {
  const drag = { over: false, read };
  platformDrag = drag;
  target.addEventListener("drop", () => { setTimeout(() => { drag.over = false; }); });
  return (over) => { drag.over = over; };
}

/** Whether a drag carries files: the page's own, or another app's the platform holds (not a link). */
export function dragCarriesFiles(data: DataTransfer | null): boolean {
  return dragHasFiles(data) || (!!platformDrag?.over && dragNamesAddress(data));
}

/** A paste's refusals as a drop's read says them: the person dropped, and pasted nothing. */
const DROP_WORDS: Record<string, string> = {
  [TOO_LARGE_TO_PASTE]: "That is too large to drop. Send it with + → Document.",
  // The platform's shelf (apps/desktop/src/clipboard.rs) let the drop's files go before the page read them.
  "That paste is gone. Paste it again.": "That drop is gone. Drop it again.",
};

/** A paste's or a drop's files the platform read into the page, and the names of those it left out (`ClipboardFiles`). */
export interface PlatformFiles { files: File[]; pastLimit: string[]; leftOut: string[] }

async function readAllPlatformFiles(clips: ClipboardFiles): Promise<PlatformFiles> {
  const { pastLimit = [], leftOut = [] } = clips;
  return { files: await readPlatformFiles(clips, new Date(), true), pastLimit, leftOut };
}

/**
 * The files of a drop the platform holds (`followPlatformDrags`), read into the page as a paste's are; null when the
 * drop handed the page its files itself, or is no drop of files.
 */
export function platformDroppedFiles(data: DataTransfer | null): Promise<PlatformFiles> | null {
  if (!platformDrag?.over || dragHasFiles(data) || !dragNamesAddress(data)) return null;
  return platformDrag.read().then(readAllPlatformFiles).catch((error: unknown) => {
    const words = DROP_WORDS[error instanceof Error ? error.message : String(error)];
    throw words ? new Error(words) : error;
  });
}

/** Tests only. */
export function resetPlatformDrags(): void {
  platformDrag = null;
}

/**
 * Keeps a file dropped where nothing takes it from opening in place of the app (a browser tab
 * shows it, the desktop app's window would navigate to it), and a link or a file named by its
 * address too. Where a drop is taken, its handler has already said so.
 */
export function guardFileDrops(target: Window = window): () => void {
  const ours = (e: DragEvent) => {
    if (e.defaultPrevented) return false;
    const on = e.target instanceof Element ? e.target : null;
    // A file field on the page (a backup to restore) takes its drop as the browser does. Another app's files the
    // platform holds are files too: never their address in a text field.
    if (dragCarriesFiles(e.dataTransfer)) return !on?.closest("input[type='file']");
    // An address dropped into a text field is its text.
    return dragNamesAddress(e.dataTransfer) && !on?.closest("input, textarea, [contenteditable=''], [contenteditable='true']");
  };
  const over = (e: DragEvent) => {
    if (!ours(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
  };
  const drop = (e: DragEvent) => { if (ours(e)) e.preventDefault(); };
  target.addEventListener("dragover", over);
  target.addEventListener("drop", drop);
  return () => { target.removeEventListener("dragover", over); target.removeEventListener("drop", drop); };
}

/**
 * Whether a paste showed the page nothing at all: no files and no text. Some webviews keep copied
 * files or a picture from the page; the platform may still read them (`platformPastedFiles`).
 */
export function pasteShowsNothing(data: DataTransfer | null): boolean {
  return !!data && !filesOf(data).length && !data.getData("text/plain") && !data.getData("text/html");
}

/**
 * Whether a paste is a web browser's "Copy image": HTML that is one picture and no text, and plain text that is
 * nothing or that picture's address (Firefox's). WebKitGTK hands the page that HTML but not the picture beside it;
 * the platform may still read it. A rich copy with words beside its pictures is text.
 */
export function pasteIsPictureOnly(data: DataTransfer | null): boolean {
  if (!data || filesOf(data).length) return false;
  // The plain text first, which costs nothing: a picture's copy has none (Chromium) or its address, one word (Firefox).
  // Anything else is text, and the HTML is never read: WebKitGTK makes it again on every `getData`, 90 ms a MB, and a
  // whole page copied was a read and a parse of its HTML on each paste, 0.1-0.9 s (agents#1575).
  const plain = data.getData("text/plain").trim();
  if (/\s/.test(plain)) return false;
  const html = data.getData("text/html");
  // One picture's HTML names one `<img`: no parse for anything else.
  if (!html || (html.match(/<img\b/gi)?.length ?? 0) !== 1) return false;
  const body = new DOMParser().parseFromString(html, "text/html").body;
  const images = body.querySelectorAll("img");
  if (images.length !== 1 || body.textContent?.trim()) return false;
  return !plain || plain === images[0].getAttribute("src")?.trim() || plain === images[0].src;
}

/**
 * Whether a paste says it carries files and hands the page none of them, nor any text. iOS Safari pastes a file copied
 * in Files (a PDF) that way: WebKit reads only pictures off the iPhone's clipboard, and keeps the rest from the page.
 */
export function pasteKeepsFiles(data: DataTransfer | null): boolean {
  return pasteShowsNothing(data) && [...(data?.types ?? [])].includes("Files");
}

/** Whether a paste named copied files it did not hand over (WebKitGTK shows a file manager's copy as `text/uri-list` only). */
export function pasteNamesFiles(data: DataTransfer | null): boolean {
  return !!data && [...(data.types ?? [])].some((type) => type === "Files" || type === "text/uri-list");
}

/** The type of something the platform read: the one it gave, or the one its name's extension says ("" when neither does). */
const clipType = (clip: ClipboardFile) => clip.mime ?? TYPES[clip.name?.split(".").pop()?.toLowerCase() ?? ""] ?? "";

/**
 * What the platform read from the clipboard, as files to send; a picture is named after the moment. Read or not
 * (too large, a read that failed), the platform is told it may let its copies go. `together`: the files must fit
 * the limit as one, not each alone (a paste: every byte read is held in the page until the sheet sends or drops it).
 */
export async function readPlatformFiles(clips: ClipboardFile[], at: Date = new Date(), together = false): Promise<File[]> {
  try {
    const largest = together ? clips.reduce((sum, clip) => sum + clip.size, 0) : Math.max(0, ...clips.map((clip) => clip.size));
    if (largest > PLATFORM_PASTE_MAX) throw new Error(TOO_LARGE_TO_PASTE);
    const files: File[] = [];
    for (const clip of clips) {
      const parts: Uint8Array[] = [];
      for (let offset = 0; offset < clip.size;) {
        const bytes = await clip.read(offset, READ_STEP);
        if (!bytes.length) break;
        parts.push(bytes);
        offset += bytes.length;
      }
      const type = clipType(clip);
      files.push(new File(parts as BlobPart[], clip.name ?? pastedImageName(type || "image/png", at), { type, lastModified: at.getTime() }));
    }
    return files;
  } finally {
    for (const clip of clips) clip.done?.();
  }
}

/** The clipboard's files as the platform reads them (the desktop app), or null where the paste event is the only way. */
export function platformPastedFiles(): Promise<PlatformFiles> | null {
  const read = servicesPlatform?.readClipboardFiles();
  return read ? read.then(readAllPlatformFiles) : null;
}

/**
 * The clipboard's first picture as the platform reads it, for a place that takes one picture (Join's QR screenshot);
 * null where the paste event is the only way. Resolves to null when the clipboard holds no picture, to "tooLarge" for a
 * copied file over `max` bytes, and to "tooManyPixels" for a picture the platform made a PNG of (it has no name) whose
 * header says more pixels than may be decoded here (`previewable`): neither is read past its header. The picture
 * resolved has passed its check: the caller does not weigh its bytes again. That PNG is judged by its pixels,
 * not its bytes, which say only how well it packed at the platform's quick level (a 12 MP phone photo came to 14 MB).
 * Whatever else was copied with it is not read either.
 */
export function platformPastedImage(max: number): Promise<File | "tooLarge" | "tooManyPixels" | null> | null {
  const read = servicesPlatform?.readClipboardFiles();
  return read ? read.then((clips) => firstImage(clips, max)) : null;
}

/**
 * The first picture of a drop the platform holds (`followPlatformDrags`), for a place that takes one picture, read and
 * checked as `platformPastedImage` reads the clipboard's; null when the drop handed the page its files itself, or is no
 * drop of files.
 */
export function platformDroppedImage(data: DataTransfer | null, max: number): Promise<File | "tooLarge" | "tooManyPixels" | null> | null {
  if (!platformDrag?.over || dragHasFiles(data) || !dragNamesAddress(data)) return null;
  return platformDrag.read().then((clips) => firstImage(clips, max));
}

async function firstImage(clips: ClipboardFile[], max: number): Promise<File | "tooLarge" | "tooManyPixels" | null> {
  const image = clips.find((clip) => clipType(clip).startsWith("image/"));
  for (const clip of clips) if (clip !== image) clip.done?.();
  if (!image) return null;
  if (image.name !== null && image.size > max) { image.done?.(); return "tooLarge"; }
  if (image.name === null) {
    let head: Uint8Array;
    try { head = await image.read(0, IMAGE_LIMITS.headBytes); } catch (cause) { image.done?.(); throw cause; }
    // One whose header says no size is left to the reader's own check, which refuses it as a picture it cannot read.
    const size = imageSize(head);
    if (size && !previewable(size)) { image.done?.(); return "tooManyPixels"; }
  }
  return (await readPlatformFiles([image]))[0] ?? null;
}

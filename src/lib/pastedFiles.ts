/**
 * Files pasted or dropped into a chat: what of a paste or a drop is sent as files, and the name a
 * pasted image gets. Text stays text: a paste with no files is left to the field, and so is a rich
 * copy (a spreadsheet's cells, a document's paragraph) that carries a picture of itself beside its
 * text and HTML.
 */

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp",
  "image/tiff": "tiff", "image/heic": "heic", "image/heif": "heif", "image/avif": "avif", "image/svg+xml": "svg",
};

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
 * Keeps a file dropped where nothing takes it from opening in place of the app (a browser tab
 * shows it, the desktop app's window would navigate to it). Where a drop is taken, its handler
 * has already said so.
 */
export function guardFileDrops(target: Window = window): () => void {
  const over = (e: DragEvent) => {
    if (e.defaultPrevented || !dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
  };
  const drop = (e: DragEvent) => { if (!e.defaultPrevented && dragHasFiles(e.dataTransfer)) e.preventDefault(); };
  target.addEventListener("dragover", over);
  target.addEventListener("drop", drop);
  return () => { target.removeEventListener("dragover", over); target.removeEventListener("drop", drop); };
}

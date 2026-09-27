import { safeBlobType, sanitizeFileName, voiceDownloadName } from "@ghostly/core";
import type { FileTransferState, ServicesPlatform } from "./platform";
import type { ChatFile } from "./types";

/** Whether a file message's bytes can be saved now: the others say why not. */
export type DownloadState = "ready" | "preparing" | "arriving" | "failed";

/**
 * A file sent from here is kept whole once it is prepared (a large one is copied into storage first). One
 * received can be saved once its transfer is done, or when nothing is known about a transfer (history, after a
 * restart).
 */
export function downloadState(transfer: FileTransferState | null, sender: "me" | "peer"): DownloadState {
  if (transfer?.state === "transferring" && transfer.stage === "preparing") return "preparing";
  if (sender === "me" || transfer === null || transfer.state === "done") return "ready";
  return transfer.state === "failed" ? "failed" : "arriving";
}

/** The name to save a file under: a voice message gets one made from its time and type, in its own container. */
export function downloadName(file: ChatFile, timestamp: number): string {
  return sanitizeFileName(file.voice ? voiceDownloadName(file.mime, timestamp) : file.name);
}

/** How long an object URL outlives the click that downloads it: long enough for any browser to start reading it. */
const URL_LIFETIME_MS = 60_000;

/**
 * Saves a copy of a file. The desktop app asks where through the system's save dialog (its save command cleans
 * the name again and writes only to the chosen path); the web and the extension download it through an object
 * URL with the `download` attribute, typed with `safeBlobType` so nothing downloaded is handed out as a page.
 * `missing` when the bytes are gone from this device.
 */
export async function downloadFile(platform: ServicesPlatform, file: ChatFile, name: string): Promise<"saved" | "cancelled" | "missing"> {
  const saved = await platform.saveFile?.(file.id, name);
  if (saved === true) return "saved";
  if (saved === false) return "cancelled";
  const blob = await platform.getFile(file.id);
  if (!blob) return "missing";
  const type = safeBlobType(blob.type);
  const url = URL.createObjectURL(blob.type === type ? blob : new Blob([blob], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), URL_LIFETIME_MS);
  return "saved";
}

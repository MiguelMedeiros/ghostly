import { safeBlobType, sanitizeFileName, voiceDownloadName } from "@ghostly/core";
import type { FileTransferState, ServicesPlatform } from "./platform";
import type { ChatFile } from "./types";

/** Whether a file message's bytes can be saved now: the others say why not. */
export type DownloadState = "ready" | "preparing" | "restoring" | "arriving" | "failed";

/**
 * A file sent from here is kept whole once it is prepared (a large one is copied into storage first). One
 * received can be saved once its transfer is done, or when nothing is known about a transfer (history, after a
 * restart) once the engine has put its kept transfers back (`restoring` until then: it may still be arriving).
 */
export function downloadState(transfer: FileTransferState | null, sender: "me" | "peer", restoring = false): DownloadState {
  if (transfer?.state === "transferring" && transfer.stage === "preparing") return "preparing";
  if (sender === "me") return "ready";
  if (transfer === null && restoring) return "restoring";
  if (transfer === null || transfer.state === "done") return "ready";
  return transfer.state === "failed" ? "failed" : "arriving";
}

/** How a file is saved: as it is, or (a voice message) converted to MP3 first. */
export type DownloadFormat = "original" | "mp3";

/**
 * The name to save a file under: a voice message gets one made from its time and type, in its own container
 * or as MP3.
 */
export function downloadName(file: ChatFile, timestamp: number, format: DownloadFormat = "original"): string {
  if (!file.voice) return sanitizeFileName(file.name);
  return sanitizeFileName(voiceDownloadName(format === "mp3" ? "audio/mpeg" : file.mime, timestamp));
}

/** How long an object URL outlives the click that downloads it: long enough for any browser to start reading it. */
const URL_LIFETIME_MS = 60_000;

/**
 * Saves a copy of a file. The desktop app asks where through the system's save dialog (its save command cleans
 * the name again and writes only to the chosen path); the web and the extension download it through an object
 * URL with the `download` attribute, typed with `safeBlobType` so nothing downloaded is handed out as a page.
 * `missing` when the bytes are gone from this device.
 */
export async function downloadFile(platform: ServicesPlatform, file: ChatFile, name: string, format: DownloadFormat = "original"): Promise<"saved" | "cancelled" | "missing"> {
  if (format === "mp3") return downloadMp3(platform, file, name);
  const saved = await platform.saveFile?.(file.id, name);
  if (saved === true) return "saved";
  if (saved === false) return "cancelled";
  const blob = await platform.getFile(file.id);
  if (!blob) return "missing";
  saveThroughLink(blob, name);
  return "saved";
}

/**
 * A voice message converted to MP3 here (`voiceToMp3`, loaded when first asked for) and saved the same ways as
 * the original: the desktop app's save dialog, else a download. Throws when the recording cannot be converted.
 */
async function downloadMp3(platform: ServicesPlatform, file: ChatFile, name: string): Promise<"saved" | "cancelled" | "missing"> {
  const recording = await platform.getFile(file.id);
  if (!recording) return "missing";
  const { voiceToMp3 } = await import("./voiceMp3");
  const mp3 = await voiceToMp3(recording);
  const saved = await platform.saveBlob?.(mp3, name);
  if (saved === true) return "saved";
  if (saved === false) return "cancelled";
  saveThroughLink(mp3, name);
  return "saved";
}

/**
 * Saves bytes made here (a backup) under `name`: through the system's save dialog where the platform has one (the
 * desktop app, whose WebView downloads nothing from a link), else as a download. `cancelled` when the person closed
 * the dialog: nothing was saved.
 */
export async function saveMade(platform: Pick<ServicesPlatform, "saveBlob"> | null | undefined, blob: Blob, name: string): Promise<"saved" | "downloaded" | "cancelled"> {
  const saved = await platform?.saveBlob?.(blob, name);
  if (saved === true) return "saved";
  if (saved === false) return "cancelled";
  saveThroughLink(blob, name);
  return "downloaded";
}

function saveThroughLink(blob: Blob, name: string): void {
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
}

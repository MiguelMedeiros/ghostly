import { formatFileSize } from "./format";
import type { FileTransferState } from "./platform";
import type { ChatFile } from "./types";

/** "3 min left", "2 h 5 min left", "less than a minute left". */
export function timeLeft(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return "less than a minute left";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return rest ? `${hours} h ${rest} min left` : `${hours} h left`;
}

const percent = (transfer: FileTransferState) => Math.floor((transfer.transferred / Math.max(1, transfer.size)) * 100);

/** The line under the file's name: how far it got, and what it waits for. */
export function fileStatus(file: ChatFile, transfer: FileTransferState | null, peerName: string, missing: boolean): string {
  const size = formatFileSize(file.size);
  if (!transfer || transfer.state === "done") return missing ? "No longer available" : size;
  if (transfer.state === "failed") return `Failed: ${transfer.error ?? "transfer interrupted"}`;
  const done = `${percent(transfer)}%`;
  const incoming = transfer.direction === "in";
  switch (transfer.stage) {
    case "preparing": return `Preparing… ${done} of ${size}`;
    case "waiting": return transfer.transferred > 0 ? `Waiting for connection · ${done} done` : `Waiting for connection · ${size}`;
    case "asking": return incoming ? `${size} · waiting for your answer` : `Waiting for ${peerName} to accept · ${size}`;
    case "queued": return incoming ? `Waiting its turn · ${done} done` : `Queued by ${peerName} · ${done} done`;
    case "paused": return `${transfer.pausedBy === "peer" ? `Paused by ${peerName}` : "Paused"} · ${done} of ${size}`;
    case "verifying": return `Checking the file… ${size}`;
  }
  const parts = [`${done} of ${size}`];
  if (transfer.rate && transfer.rate > 0) {
    parts.push(`${formatFileSize(Math.round(transfer.rate))}/s`);
    const left = timeLeft((transfer.size - transfer.transferred) / transfer.rate);
    if (left) parts.push(left);
  }
  return parts.join(" · ");
}

import { formatFileSize } from "./format";
import type { FileAction, FileTransferState } from "./platform";
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

/**
 * A transfer that ended without the file, in two words: declined, cancelled, or not sent / did not arrive. The
 * error's own words are the reason behind the bubble's ⓘ, never the status itself.
 */
export function failedStatus(file: ChatFile, transfer: FileTransferState): string {
  const error = transfer.error ?? "";
  if (/declin/i.test(error)) return "Declined";
  if (/cancel/i.test(error)) return "Cancelled";
  return transfer.direction === "out" || (!transfer.direction && file.id.includes("-out-")) ? "Not sent" : "Did not arrive";
}

/** The line under the file's name: how far it got, and what it waits for. */
export function fileStatus(file: ChatFile, transfer: FileTransferState | null, peerName: string, missing: boolean): string {
  const size = formatFileSize(file.size);
  if (!transfer || transfer.state === "done") return missing ? "No longer available" : size;
  if (transfer.state === "failed") return failedStatus(file, transfer);
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
  // Nothing moved for a while (or since the app started): said, so the person knows why "Send again" is there.
  if (transfer.stalled) return `Not moving · ${done} of ${size}`;
  const parts = [`${done} of ${size}`];
  if (transfer.rate && transfer.rate > 0) {
    parts.push(`${formatFileSize(Math.round(transfer.rate))}/s`);
    const left = timeLeft((transfer.size - transfer.transferred) / transfer.rate);
    if (left) parts.push(left);
  }
  return parts.join(" · ");
}

/**
 * What a stuck files/3 transfer offers its person: "Send again" (sending) or "Ask again" (receiving), with a one-line
 * hint. Either goes on from what the receiver holds; null when it is moving, or waits for a person.
 */
export function stalledAction(transfer: FileTransferState | null): { action: Extract<FileAction, "resend" | "request">; label: string; hint: string } | null {
  if (transfer?.state !== "transferring" || !transfer.stalled || !transfer.direction) return null;
  return transfer.direction === "out"
    ? { action: "resend", label: "Send again", hint: "Offers it again. It goes on from what your contact already has." }
    : { action: "request", label: "Ask again", hint: "Asks your contact for the rest. What arrived stays." };
}

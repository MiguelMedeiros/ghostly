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
 * A transfer that ended without the file, in a word or two: why is behind ⓘ (`transferReason`), never the engine's
 * words in the bubble.
 */
function endedLabel(file: ChatFile, transfer: FileTransferState): string {
  const why = transfer.error ?? "";
  if (/declined/i.test(why)) return "Declined";
  if (/cancel/i.test(why)) return "Cancelled";
  return file.id.includes("-out-") ? "Not sent" : "Not received";
}

/** The line under the file's name: how far it got, and what it waits for. */
export function fileStatus(file: ChatFile, transfer: FileTransferState | null, peerName: string, missing: boolean): string {
  const size = formatFileSize(file.size);
  if (!transfer || transfer.state === "done") return missing ? "No longer available" : size;
  if (transfer.state === "failed") return endedLabel(file, transfer);
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
  if (transfer.stalled) return `Stalled · ${done} of ${size}`;
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

/** What the round button in the icon's place does: send a failed file again, push a stuck one, or ask for the rest. */
export interface TransferMove { action: "retry" | Extract<FileAction, "resend" | "request">; label: string; hint: string }

/**
 * The round button a file or voice note shows in its icon's place, or null: "Retry sending" for one that failed and can
 * go again (not one the contact cancelled or declined), "Send again" / "Ask again" for one that stalled.
 */
export function transferMove(file: ChatFile, transfer: FileTransferState | null, can: { retry: boolean; act: boolean }): TransferMove | null {
  if (transfer?.state === "failed") {
    const again = can.retry && file.id.includes("-out-") && (transfer.direction ? !!transfer.retry : true);
    return again ? { action: "retry", label: "Retry sending", hint: "Sends it again." } : null;
  }
  const stuck = can.act ? stalledAction(transfer) : null;
  return stuck && { action: stuck.action, label: stuck.label, hint: stuck.hint };
}

/** Why a transfer stopped, for ⓘ: the engine's own words when it failed, what the button does when it stalled. */
export function transferReason(transfer: FileTransferState | null): string | null {
  if (transfer?.state === "failed") return transfer.error ?? "The transfer was interrupted.";
  return stalledAction(transfer)?.hint.replace(/^/, "Nothing moved for a while. ") ?? null;
}

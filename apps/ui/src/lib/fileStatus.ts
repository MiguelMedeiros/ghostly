import { formatFileSize } from "./format";
import type { FileAction, FileTransferState, ServicesPlatform } from "./platform";
import type { ChatFile } from "./types";
import { englishT, type Translate } from "../locales/translate";

/** "3 min left", "2 h 5 min left", "less than a minute left". */
export function timeLeft(seconds: number, tr: Translate = englishT): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return tr("chat.file.leftUnderMinute");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return tr("chat.file.leftMinutes", { minutes });
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return rest ? tr("chat.file.leftHoursMinutes", { hours, minutes: rest }) : tr("chat.file.leftHours", { hours });
}

const percent = (transfer: FileTransferState) => Math.floor((transfer.transferred / Math.max(1, transfer.size)) * 100);

/**
 * Whether a file sent from here that did not go can be sent again: not one the contact declined or the sender
 * cancelled (files/3 says so with `retry`), and only where the platform sends files.
 */
export function canRetryFile(file: ChatFile, transfer: FileTransferState | null, platform: ServicesPlatform | null): boolean {
  return transfer?.state === "failed" && file.id.includes("-out-") && !!platform?.retryFile && (transfer.direction ? !!transfer.retry : true);
}

/**
 * A transfer that ended without the file, in two words: declined, cancelled, or not sent / did not arrive. The
 * error's own words are the reason behind the bubble's ⓘ, never the status itself.
 */
export function failedStatus(file: ChatFile, transfer: FileTransferState, tr: Translate = englishT): string {
  const error = transfer.error ?? "";
  if (/declin/i.test(error)) return tr("chat.file.declined");
  if (/cancel/i.test(error)) return tr("chat.file.cancelled");
  return transfer.direction === "out" || (!transfer.direction && file.id.includes("-out-")) ? tr("chat.delivery.failed") : tr("chat.message.downloadFailed");
}

/**
 * The line under the file's name: how far it got, and what it waits for. `named` is the contact's name, if it has
 * one: without, the line says "your contact", in lower case, as it sits mid-sentence.
 */
export function fileStatus(file: ChatFile, transfer: FileTransferState | null, named: string | undefined, missing: boolean, tr: Translate = englishT): string {
  const size = formatFileSize(file.size);
  const peerName = named ?? tr("chat.file.yourContact");
  if (!transfer || transfer.state === "done") return missing ? tr("chat.file.gone") : size;
  if (transfer.state === "failed") return failedStatus(file, transfer, tr);
  const done = `${percent(transfer)}%`;
  const incoming = transfer.direction === "in";
  const of = tr("chat.file.of", { done, size });
  switch (transfer.stage) {
    case "preparing": return tr("chat.file.preparing", { progress: of });
    case "waiting": return transfer.transferred > 0 ? tr("chat.file.waitingDone", { done }) : tr("chat.file.waitingSize", { size });
    case "asking": return incoming ? tr("chat.file.askingYou", { size }) : tr("chat.file.askingThem", { name: peerName, size });
    case "queued": return incoming ? tr("chat.file.queuedHere", { done }) : tr("chat.file.queuedThere", { name: peerName, done });
    case "paused": return `${transfer.pausedBy === "peer" ? tr("chat.file.pausedBy", { name: peerName }) : tr("chat.file.paused")} · ${of}`;
    case "verifying": return tr("chat.file.verifying", { size });
  }
  // Nothing moved for a while (or since the app started): said, so the person knows why "Send again" is there.
  if (transfer.stalled) return tr("chat.file.stalled", { progress: of });
  const parts = [of];
  if (transfer.rate && transfer.rate > 0) {
    parts.push(`${formatFileSize(Math.round(transfer.rate))}/s`);
    const left = timeLeft((transfer.size - transfer.transferred) / transfer.rate, tr);
    if (left) parts.push(left);
  }
  return parts.join(" · ");
}

/**
 * What a stuck files/3 transfer offers its person: "Send again" (sending) or "Ask again" (receiving), with a one-line
 * hint. Either goes on from what the receiver holds; null when it is moving, or waits for a person.
 */
export function stalledAction(transfer: FileTransferState | null, tr: Translate = englishT): { action: Extract<FileAction, "resend" | "request">; label: string; hint: string } | null {
  if (transfer?.state !== "transferring" || !transfer.stalled || !transfer.direction) return null;
  return transfer.direction === "out"
    ? { action: "resend", label: tr("chat.message.retry"), hint: tr("chat.file.resendHint") }
    : { action: "request", label: tr("chat.file.askAgain"), hint: tr("chat.file.askAgainHint") };
}

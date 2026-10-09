import { knownErrorParts } from "./errorText";
import { formatFileSize } from "./format";
import type { FileAction, FileHeld, FileTransferState, ServicesPlatform } from "./platform";
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
 * A group's file (WISP 503), by its local id (`group-<group>-in-…`, `group-<group>-out-…`). Each member's app fetches it
 * from whoever holds it: it is downloaded, never declined, paused, cancelled or sent again.
 */
export const isGroupFile = (file: Pick<ChatFile, "id">): boolean => file.id.startsWith("group-");

/** A group's file this device has not fetched, waiting for its person's Download. */
export const groupFileOffered = (file: Pick<ChatFile, "id">, transfer: FileTransferState | null): boolean =>
  isGroupFile(file) && transfer?.state === "transferring" && transfer.direction === "in" && transfer.stage === "asking";

/**
 * Whether a file sent from here that did not go can be sent again: not one the contact declined or the sender
 * cancelled (files/3 says so with `retry`), and only where the platform sends files. Never a group's: it is announced
 * once, and members fetch it from whoever has it.
 */
export function canRetryFile(file: ChatFile, transfer: FileTransferState | null, platform: ServicesPlatform | null): boolean {
  return transfer?.state === "failed" && file.id.includes("-out-") && !isGroupFile(file) && !!platform?.retryFile && (transfer.direction ? !!transfer.retry : true);
}

/**
 * Why a group's file waits, behind its ⓘ: what comes next while nobody this device is connected to has it. Null for
 * any other file or state.
 */
export function groupFileHint(file: Pick<ChatFile, "id">, transfer: FileTransferState | null, tr: Translate = englishT): string | null {
  return isGroupFile(file) && transfer?.state === "transferring" && transfer.stage === "waiting" && transfer.wait === "nobody" ? tr("chat.file.nobodyHasHint") : null;
}

/**
 * A transfer that ended without the file, in a few words: declined, cancelled, why when the app knows its error (the
 * contact's app refused it: no room, too many files waiting...), else not sent / did not arrive. An error's own
 * English is the reason behind the bubble's ⓘ, never the status itself.
 */
export function failedStatus(file: ChatFile, transfer: FileTransferState, tr: Translate = englishT): string {
  const error = transfer.error ?? "";
  if (/declin/i.test(error)) return tr("chat.file.declined");
  if (/cancel/i.test(error)) return tr("chat.file.cancelled");
  const known = error ? knownErrorParts(error, tr) : null;
  if (known) return known.title;
  return transfer.direction === "out" || (!transfer.direction && file.id.includes("-out-")) ? tr("chat.delivery.failed") : tr("chat.message.downloadFailed");
}

/**
 * What a failed transfer's ⓘ says: the next step in the app's language when the app knows its error (its title is
 * the status), else the error's own words, in English (`english`: laid out and read as such).
 */
export function failedReason(transfer: FileTransferState | null, tr: Translate = englishT): { text: string; english?: true } | undefined {
  if (transfer?.state !== "failed" || !transfer.error) return undefined;
  const known = knownErrorParts(transfer.error, tr);
  if (!known) return { text: transfer.error, english: true };
  if (known.next) return { text: known.next };
  return known.detail ? { text: known.detail, english: true } : undefined;
}

/**
 * Whether this device holds a stored file's bytes, asked when it hands out none: `here` (too large to hand out, saved
 * through the system), `gone`, or `left-out` of a light backup. A platform that cannot tell says `here` where it can
 * save the file and its transfer finished, as before.
 */
export async function fileHeld(platform: Pick<ServicesPlatform, "fileHeld" | "saveFile">, fileId: string, done: boolean): Promise<FileHeld> {
  const held = await platform.fileHeld?.(fileId).catch(() => null);
  return held ?? (platform.saveFile && done ? "here" : "gone");
}

/**
 * The line under the file's name: how far it got, and what it waits for. `named` is the contact's name, if it has
 * one: without, the line says "your contact", in lower case, as it sits mid-sentence. `missing`: its bytes are not on
 * this device (`left-out`: a light backup left them out).
 */
export function fileStatus(file: ChatFile, transfer: FileTransferState | null, named: string | undefined, missing: boolean | "left-out", tr: Translate = englishT): string {
  const size = formatFileSize(file.size);
  const peerName = named ?? tr("chat.file.yourContact");
  if (!transfer || transfer.state === "done") return missing === "left-out" ? tr("chat.file.notInBackup") : missing ? tr("chat.file.gone") : size;
  if (transfer.state === "failed") return failedStatus(file, transfer, tr);
  const done = `${percent(transfer)}%`;
  const incoming = transfer.direction === "in";
  const of = tr("chat.file.of", { done, size });
  // A group's file on its way here (WISP 503): not fetched yet, asked of a member, or nobody reachable has it.
  if (isGroupFile(file) && incoming) {
    if (transfer.stage === "asking") return tr("chat.file.notDownloaded", { size });
    if (transfer.stage === "queued") return tr("chat.file.askingMember");
    if (transfer.stage === "waiting" && transfer.wait === "nobody") return tr("chat.file.nobodyHas");
  }
  switch (transfer.stage) {
    case "preparing": return tr("chat.file.preparing", { progress: of });
    case "waiting":
      // A group's file says why it waits: its holders busy, or its bytes damaged; else, as a chat's, for a connection.
      if (transfer.wait === "damaged") return tr("chat.file.damaged", { size });
      if (transfer.wait === "busy") return transfer.transferred > 0 ? tr("chat.file.busyDone", { done }) : tr("chat.file.busySize", { size });
      return transfer.transferred > 0 ? tr("chat.file.waitingDone", { done }) : tr("chat.file.waitingSize", { size });
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
 * hint. Either goes on from what the receiver holds; null when it is moving, or waits for a person. A group's file
 * that stopped arriving (every copy came damaged, `retry`) offers "Ask again" too: its members are asked once more.
 */
export function stalledAction(transfer: FileTransferState | null, tr: Translate = englishT): { action: Extract<FileAction, "resend" | "request">; label: string; hint: string } | null {
  if (transfer?.state === "failed" && transfer.direction === "in" && transfer.retry) return { action: "request", label: tr("chat.file.askAgain"), hint: tr("chat.file.askGroupAgainHint") };
  if (transfer?.state !== "transferring" || !transfer.stalled || !transfer.direction) return null;
  return transfer.direction === "out"
    ? { action: "resend", label: tr("chat.message.retry"), hint: tr("chat.file.resendHint") }
    : { action: "request", label: tr("chat.file.askAgain"), hint: tr(transfer.wait === "damaged" ? "chat.file.askAgainDamagedHint" : "chat.file.askAgainHint") };
}

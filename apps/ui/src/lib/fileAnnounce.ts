import type { Translate } from "../locales/translate";
import { failedStatus, isGroupFile } from "./fileStatus";
import { formatFileSize } from "./format";
import type { FileTransferState } from "./platform";
import type { ChatFile } from "./types";

/**
 * Where a chat's file stands, as far as its person needs to hear it: waiting for an answer, moving (the percent is not
 * news), paused by this side or by the contact, arrived, or ended without it. Null: no transfer shown (yet, or any more).
 */
export type FileMoment = "offered" | "moving" | "paused-me" | "paused-peer" | "done" | "failed";

export function fileMoment(transfer: FileTransferState | null): FileMoment | null {
  if (!transfer) return null;
  if (transfer.state === "done") return "done";
  if (transfer.state === "failed") return "failed";
  // A sent file's `queued` is the contact's app taking it after others: answered already.
  if (transfer.stage === "asking") return "offered";
  if (transfer.stage === "paused") return transfer.pausedBy === "peer" ? "paused-peer" : "paused-me";
  return "moving";
}

/** An offer of a 1:1 file waiting for this person's Accept or Decline: its arrival says so. */
export function fileOfferLine(file: ChatFile, transfer: FileTransferState | null, name: string, t: Translate): string | null {
  if (isGroupFile(file) || transfer?.state !== "transferring" || transfer.stage !== "asking" || transfer.direction === "out") return null;
  return t("chat.announce.fileOffer", { name, file: file.name, size: formatFileSize(file.size, t) });
}

/**
 * What a 1:1 file's step from `before` to `now` is read out as, once: the contact answered, paused or went on, it
 * arrived, or it ended without the file. Null for a step this person took (Accept, Pause, Decline, Cancel: the button
 * they pressed said it), for one nobody needs to hear (moving again after a wait for the connection), and when where it
 * stood before is not known. `name`: the contact's.
 */
export function fileMomentLine(file: ChatFile, before: FileMoment | null, now: FileMoment | null, transfer: FileTransferState | null, name: string, t: Translate): string | null {
  if (!before || !now || before === now || !transfer || isGroupFile(file)) return null;
  const sent = transfer.direction === "out" || (!transfer.direction && file.id.includes("-out-"));
  const values = { name, file: file.name };
  switch (now) {
    // The contact said yes to a file sent from here; Accept on a received one is this person's own.
    case "moving":
      if (before === "offered") return sent ? t("chat.announce.fileAccepted", values) : null;
      return before === "paused-peer" ? t("chat.announce.fileResumed", values) : null;
    case "paused-peer": return t("chat.announce.filePaused", values);
    case "done": return before === "failed" ? null : t(sent ? "chat.announce.fileDelivered" : "chat.announce.fileArrived", values);
    case "failed": {
      const error = transfer.error ?? "";
      // "You declined it", "You cancelled it": this person's own answer.
      if (/^You /.test(error)) return null;
      if (/declin/i.test(error)) return t("chat.announce.fileDeclined", values);
      if (/cancel/i.test(error)) return t("chat.announce.fileCancelled", values);
      return t("chat.announce.fileFailed", { file: file.name, status: failedStatus(file, transfer, t) });
    }
  }
  return null;
}

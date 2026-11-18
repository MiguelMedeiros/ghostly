import type { FileTransferView, LinkView } from "@ghostly/browser/shared/types";

/** The start of `FileDesk.accept`'s refusal for an offer that fits the free space but not beside the files still coming. */
const ROOM_HELD = "No room on this device for this file beside the files still coming";

/** Accept was refused because files already taken, still coming, hold the room (`FileDesk.accept`). */
export const roomHeld = (error: unknown): boolean => error instanceof Error && error.message.startsWith(ROOM_HELD);

/** A 1:1 file taken here and still coming: the room it holds until it arrives (`ChatFiles.stillToCome`). */
export interface ComingFile {
  fileId: string;
  linkId: string;
  /** Bytes still to come. */
  left: number;
}

/**
 * The files still coming that hold this device's room, as the engine counts them (`ChatFiles.stillToCome`): received in
 * a 1:1 chat, taken (not one still asked about), not ended, largest first. A group's file is not counted there. Read
 * from the engine's state on this device only: nothing of another chat goes to the contact who offered `except`.
 */
export function filesStillComing(transfers: Readonly<Record<string, FileTransferView>> | undefined, links: readonly Pick<LinkView, "id">[] | undefined, except?: string): ComingFile[] {
  if (!transfers || !links?.length) return [];
  const coming: ComingFile[] = [];
  for (const [fileId, view] of Object.entries(transfers)) {
    if (fileId === except || view.direction !== "in" || view.state !== "transferring" || view.stage === "asking") continue;
    const link = links.find((l) => fileId.startsWith(`${l.id}-in-`));
    const left = Math.max(0, view.size - view.transferred);
    if (link && left > 0) coming.push({ fileId, linkId: link.id, left });
  }
  return coming.sort((a, b) => b.left - a.left || a.fileId.localeCompare(b.fileId));
}

import { useEffect, useRef, useState, type RefObject } from "react";
import { useT } from "../contexts/I18nContext";
import { useEngineValue } from "../lib/engineState";
import { filesStillComing, roomHeld } from "../lib/filesComing";
import type { FileAction, ServicesPlatform } from "../lib/platform";
import { problemLine } from "../lib/problemText";

/** Accept's refusal for the files still coming: none, given, or given and seen with files still coming listed. */
type HeldRoom = "no" | "refused" | "listed";

/**
 * A file bubble's answers to its transfer (Accept, Decline, Pause, Resume, Cancel) and the refusal the last one got,
 * shown behind the bubble's ⓘ: the same in the file, video and voice-note bubbles.
 *
 * `heldRoom`: Accept was refused for the files still coming (`roomHeld`), and the offer lists them with a Cancel for
 * each (FilesStillComing). Once none of them is left (each cancelled here, or arrived), that refusal is dropped with
 * the list, and the offer reads as one to Accept again. Before, the red ⓘ kept saying there was no room until Accept
 * was pressed again, just after the person made some. Only that refusal: any other (no connection, cancelled by the
 * sender, no room on the device at all) stays until the next action. And only once its list was seen with files in it:
 * the engine also counts the group files it fetches and the offers it is deciding, which the list leaves out, so a
 * refusal for those alone is never dropped at once (Accept would look as if it did nothing).
 *
 * `acceptRef`: the offer's Accept, where the focus lands (`useFocusKept`) when what had it (a Cancel in the list, the ⓘ)
 * goes with the refusal.
 */
export function useFileActions(platform: ServicesPlatform | null | undefined, fileId: string): {
  act: (action: FileAction) => void;
  actionError: string;
  setActionError: (error: string) => void;
  heldRoom: boolean;
  acceptRef: RefObject<HTMLButtonElement | null>;
} {
  const t = useT();
  const [actionError, setError] = useState("");
  const [held, setHeld] = useState<HeldRoom>("no");
  const acceptRef = useRef<HTMLButtonElement>(null);
  // While it is an offer: whether any file still coming holds the room. The bubble draws again when the last one goes,
  // with the list, so the focus that was in the list is placed in the same draw (`useFocusKept`).
  const coming = useEngineValue((state) => state?.transfers?.[fileId]?.stage === "asking" && filesStillComing(state.transfers, state.links, fileId).length > 0);
  const dropped = held === "listed" && !coming;
  useEffect(() => {
    if (held === "refused" && coming) setHeld("listed");
    else if (held === "listed" && !coming) {
      setHeld("no");
      setError("");
    }
  }, [held, coming]);
  /** Another refusal (or none) takes the place of the one for the files still coming. */
  const setActionError = (error: string) => {
    setHeld("no");
    setError(error);
  };
  const act = (action: FileAction) => {
    setActionError("");
    void platform?.fileAction?.(fileId, action).catch((error: Error) => {
      setError(problemLine(error, t));
      setHeld(roomHeld(error) ? "refused" : "no");
    });
  };
  return { act, actionError: dropped ? "" : actionError, setActionError, heldRoom: held !== "no" && !dropped, acceptRef };
}

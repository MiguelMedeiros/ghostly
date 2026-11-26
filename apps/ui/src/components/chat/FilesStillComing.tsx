import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { useT } from "../../contexts/I18nContext";
import { useEngineValue } from "../../lib/engineState";
import { filesStillComing } from "../../lib/filesComing";
import { fillNames } from "../../lib/fillNodes";
import { focusLost } from "../../lib/focus";
import { formatFileSize } from "../../lib/format";
import { contactName } from "../../lib/identities";
import { servicesPlatform } from "../../lib/platform";
import { problemLine } from "../../lib/problemText";
import { contactTag } from "../../lib/publicKeyLabel";
import { loadSession, sessionIdsByPeer } from "../../lib/storage";
import { FORCED_EDGE } from "./RoundRetry";

const linkButton = `text-xs px-2.5 py-0.5 max-md:min-h-11 max-md:px-4 rounded-full bg-black/20 hover:bg-black/30 border-none ${FORCED_EDGE} text-inherit cursor-pointer transition-colors`;

/**
 * The files still coming that hold this device's room, under an offer that does not fit beside them: which file, from
 * which chat, how much of it is still to come, and a Cancel for each, so the person sees what to cancel to take the
 * offer. Before, Accept said only "wait for them to arrive, or cancel one", and nothing said which or where. `open`
 * shows the list at once (Accept was just refused for them); otherwise a button opens it. Drawn on this device only:
 * nothing of it goes to the contact who offered the file. `accept` is the offer's Accept: the focus goes there when a
 * Cancel takes the last row, and the list with it, away.
 */
export function FilesStillComing({ except, open: opened = false, accept }: { except: string; open?: boolean; accept?: RefObject<HTMLButtonElement | null> }) {
  const t = useT();
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  // The row whose Cancel was pressed, and where it stood in the list.
  const leaving = useRef<{ fileId: string; at: number } | null>(null);
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState("");
  const coming = useEngineValue((state) => filesStillComing(state?.transfers, state?.links, except));
  // Which files are listed, without what is left of each: that changes on every progress tick of a file still coming.
  const held = useEngineValue((state) => filesStillComing(state?.transfers, state?.links, except).map(({ fileId, linkId }) => ({ fileId, linkId })).sort((a, b) => a.fileId.localeCompare(b.fileId)));
  const links = useEngineValue((state) => state?.links?.map(({ id, label, peerNick, peerPubKeyZ32 }) => ({ id, label, peerNick, peerPubKeyZ32 })));
  // Each chat's stored copy read once per set of files listed, not per tick: the chat's name as the list shows it, and
  // the file's from its message. Found by its contact's key: a chat is stored under its own id, not its link's, and read
  // by the link's id every row said "A file" from the contact's fallback name.
  const names = useMemo(() => {
    const sessions = new Map<string, ReturnType<typeof loadSession>>();
    const sessionOf = sessionIdsByPeer();
    const session = (linkId: string, peer: string | undefined) => {
      if (!sessions.has(linkId)) {
        const id = peer ? sessionOf(peer) : undefined;
        sessions.set(linkId, id ? loadSession(id) : null);
      }
      return sessions.get(linkId);
    };
    return new Map(held.map((file) => {
      const link = links?.find((l) => l.id === file.linkId);
      const stored = session(file.linkId, link?.peerPubKeyZ32);
      const chat = contactName(stored ?? undefined) || link?.label || link?.peerNick || t("common.unnamedContact", { key: contactTag(link?.peerPubKeyZ32 ?? file.linkId) });
      const name = stored?.messages.find((m) => m.file?.id === file.fileId)?.file?.name || t("chat.file.comingUnnamed");
      return [file.fileId, { chat, name }];
    }));
  }, [held, links, t]);
  const shown = coming.map((file) => ({ ...file, chat: "", name: "", ...names.get(file.fileId) }));
  // A Cancel goes with its row once the file ends, and the focus fell to the page with it: it goes to the Cancel now in
  // that row's place (the one above for the last row), or to the offer's Accept once no row is left.
  useEffect(() => {
    const gone = leaving.current;
    if (!gone || shown.some((file) => file.fileId === gone.fileId)) return;
    leaving.current = null;
    if (!focusLost()) return;
    const cancels = listRef.current?.querySelectorAll<HTMLElement>("[data-testid='files-coming-cancel']") ?? [];
    (cancels[Math.min(gone.at, cancels.length - 1)] ?? accept?.current)?.focus({ preventScroll: true });
  });
  if (!shown.length) return null;
  const expanded = opened || open;
  const cancel = (fileId: string, at: number) => {
    setProblem("");
    leaving.current = { fileId, at };
    void servicesPlatform?.fileAction?.(fileId, "cancel").catch((error: Error) => { leaving.current = null; setProblem(problemLine(error, t)); });
  };
  return (
    <div className="mt-1.5" data-testid="files-coming">
      {!opened && (
        <button type="button" className={linkButton} aria-expanded={open} aria-controls={listId} data-testid="files-coming-show"
          onClick={() => setOpen((now) => !now)}>{t("chat.file.comingList", { count: shown.length })}</button>
      )}
      {expanded && (
        <div id={listId}>
          <p className="chat-text-media-meta m-0 mt-1 mb-1">{t("chat.file.comingTitle")}</p>
          <ul ref={listRef} className="m-0 p-0 list-none flex flex-col gap-1">
            {shown.map((file, at) => (
              <li key={file.fileId} className="flex items-center gap-2 [overflow-wrap:anywhere]" data-testid="files-coming-row" data-file={file.fileId}>
                <span className="chat-text-media-meta min-w-0 flex-1">
                  {fillNames(t("chat.file.comingRow", { left: formatFileSize(file.left, t) }), { file: file.name, chat: file.chat })}
                </span>
                {servicesPlatform?.fileAction && (
                  <button type="button" className={linkButton} data-testid="files-coming-cancel" aria-label={t("chat.file.comingCancel", { file: file.name })}
                    onClick={() => cancel(file.fileId, at)}>{t("common.cancel")}</button>
                )}
              </li>
            ))}
          </ul>
          {problem && <p className="chat-text-media-meta m-0 mt-1 text-danger-ink" role="alert">{problem}</p>}
        </div>
      )}
    </div>
  );
}

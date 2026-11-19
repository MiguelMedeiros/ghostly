import { useId, useMemo, useState } from "react";
import { useT } from "../../contexts/I18nContext";
import { useEngineValue } from "../../lib/engineState";
import { filesStillComing } from "../../lib/filesComing";
import { fillNames } from "../../lib/fillNodes";
import { formatFileSize } from "../../lib/format";
import { contactName } from "../../lib/identities";
import { servicesPlatform } from "../../lib/platform";
import { problemLine } from "../../lib/problemText";
import { contactTag } from "../../lib/publicKeyLabel";
import { loadSession } from "../../lib/storage";
import { FORCED_EDGE } from "./RoundRetry";

const linkButton = `text-xs px-2.5 py-0.5 max-md:min-h-11 max-md:px-4 rounded-full bg-black/20 hover:bg-black/30 border-none ${FORCED_EDGE} text-inherit cursor-pointer transition-colors`;

/**
 * The files still coming that hold this device's room, under an offer that does not fit beside them: which file, from
 * which chat, how much of it is still to come, and a Cancel for each, so the person sees what to cancel to take the
 * offer. Before, Accept said only "wait for them to arrive, or cancel one", and nothing said which or where. `open`
 * shows the list at once (Accept was just refused for them); otherwise a button opens it. Drawn on this device only:
 * nothing of it goes to the contact who offered the file.
 */
export function FilesStillComing({ except, open: opened = false }: { except: string; open?: boolean }) {
  const t = useT();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState("");
  const coming = useEngineValue((state) => filesStillComing(state?.transfers, state?.links, except));
  // Which files are listed, without what is left of each: that changes on every progress tick of a file still coming.
  const held = useEngineValue((state) => filesStillComing(state?.transfers, state?.links, except).map(({ fileId, linkId }) => ({ fileId, linkId })).sort((a, b) => a.fileId.localeCompare(b.fileId)));
  const links = useEngineValue((state) => state?.links?.map(({ id, label, peerNick, peerPubKeyZ32 }) => ({ id, label, peerNick, peerPubKeyZ32 })));
  // Each chat's stored copy read once per set of files listed, not per tick: the chat's name as the list shows it, and
  // the file's from its message.
  const names = useMemo(() => {
    const sessions = new Map<string, ReturnType<typeof loadSession>>();
    const session = (linkId: string) => {
      if (!sessions.has(linkId)) sessions.set(linkId, loadSession(linkId));
      return sessions.get(linkId);
    };
    return new Map(held.map((file) => {
      const stored = session(file.linkId);
      const link = links?.find((l) => l.id === file.linkId);
      const chat = contactName(stored ?? undefined) || link?.label || link?.peerNick || t("common.unnamedContact", { key: contactTag(link?.peerPubKeyZ32 ?? file.linkId) });
      const name = stored?.messages.find((m) => m.file?.id === file.fileId)?.file?.name || t("chat.file.comingUnnamed");
      return [file.fileId, { chat, name }];
    }));
  }, [held, links, t]);
  const shown = coming.map((file) => ({ ...file, chat: "", name: "", ...names.get(file.fileId) }));
  if (!shown.length) return null;
  const expanded = opened || open;
  const cancel = (fileId: string) => {
    setProblem("");
    void servicesPlatform?.fileAction?.(fileId, "cancel").catch((error: Error) => setProblem(problemLine(error, t)));
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
          <ul className="m-0 p-0 list-none flex flex-col gap-1">
            {shown.map((file) => (
              <li key={file.fileId} className="flex items-center gap-2 [overflow-wrap:anywhere]" data-testid="files-coming-row" data-file={file.fileId}>
                <span className="chat-text-media-meta min-w-0 flex-1">
                  {fillNames(t("chat.file.comingRow", { left: formatFileSize(file.left, t) }), { file: file.name, chat: file.chat })}
                </span>
                {servicesPlatform?.fileAction && (
                  <button type="button" className={linkButton} data-testid="files-coming-cancel" aria-label={t("chat.file.comingCancel", { file: file.name })}
                    onClick={() => cancel(file.fileId)}>{t("common.cancel")}</button>
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

import { useEffect, useState, useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { Page } from "../components/layout";
import { PeerAvatar } from "../components/Avatar";
import { GroupAvatar } from "../components/GroupAvatar";
import { shownContactName, useContactFaces } from "../components/identities/contactFace";
import { useI18n } from "../contexts/I18nContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { dropIncomingShare, sendShareTo, shareText, useIncomingShare } from "../lib/incomingShare";
import { groupChat } from "../lib/chatMute";
import { groupPath } from "../lib/groups";
import { contactTag } from "../lib/publicKeyLabel";
import { listSessions } from "../lib/storage";
import { chatPath } from "../lib/url";

const subscribeEngine = (listener: () => void) => engine.subscribe(listener);
const engineSnapshot = () => engine.state;

/** How long the page waits for a share that has not reached it yet before it says there is none. */
const WAIT_MS = 5000;

/**
 * "Share to…": something another app shared into Ghostly waits here for a chat. Picking one opens it with the
 * text in the draft and the files on the attachment sheet, to look over and send there; nothing is sent from
 * here. Groups take text only (files are not part of groups yet), so a share with files lists 1:1 chats.
 */
export function SharePicker() {
  const { t } = useI18n();
  const nav = useAppNavigation();
  const share = useIncomingShare();
  const faceOf = useContactFaces();
  const groups = useSyncExternalStore(subscribeEngine, engineSnapshot)?.groups ?? [];
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), WAIT_MS);
    return () => clearTimeout(timer);
  }, []);

  const sessions = listSessions();
  const hasFiles = !!share?.files.length;
  const openGroups = hasFiles ? [] : groups.filter((group) => !group.invitation && group.canSend);
  const preview = share ? shareText(share) : "";

  const pick = (chat: string, path: string) => {
    sendShareTo(chat);
    nav.conversation(path);
  };
  const cancel = () => {
    dropIncomingShare();
    nav.home();
  };

  return (
    <Page title={t("pwa.shareTitle")} testId="share-picker">
      {!share ? (
        <p className="text-sm text-text-muted" data-testid="share-none">{waited ? t("pwa.shareNone") : t("pwa.shareWaiting")}</p>
      ) : (
        <>
          <div className="rounded-xl bg-surface px-4 py-3 space-y-1" data-testid="share-summary">
            {hasFiles && (
              <p className="m-0 text-sm text-text-primary font-medium" data-testid="share-files">
                {share.files.length === 1 ? share.files[0]!.name || t("pwa.shareOneFile") : t("pwa.shareFiles", { count: String(share.files.length) })}
              </p>
            )}
            {preview && <p className="m-0 text-sm text-text-secondary line-clamp-3 break-words whitespace-pre-line" data-testid="share-text">{preview}</p>}
            <p className="m-0 text-xs text-text-muted">{t("pwa.shareHint")}</p>
          </div>

          {sessions.length === 0 && openGroups.length === 0 ? (
            <p className="text-sm text-text-muted">{t("pwa.shareNoChats")}</p>
          ) : (
            <ul className="rounded-xl bg-surface divide-y divide-border overflow-hidden m-0 p-0 list-none" aria-label={t("pwa.shareTitle")}>
              {sessions.map((session) => {
                const face = faceOf(session.peerPubKeyB64);
                const shown = shownContactName({ nickname: session.label, face, nick: session.nick, fallback: t("common.unnamedContact", { key: contactTag(session.peerPubKeyB64) }) });
                return (
                  <li key={session.id}>
                    <button type="button" data-testid="share-chat" onClick={() => pick(session.id, chatPath(session.id))}
                      className="w-full flex items-center gap-3 px-4 py-2.5 min-h-12 text-start hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent cursor-pointer">
                      <span className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center bg-surface-hover">
                        <PeerAvatar peerPubKey={session.peerPubKeyB64} label={shown.name} named={shown.from !== "key"} photo={face?.photo} />
                      </span>
                      <bdi className="min-w-0 truncate text-sm text-text-primary">{shown.name}</bdi>
                    </button>
                  </li>
                );
              })}
              {openGroups.map((group) => (
                <li key={group.id}>
                  <button type="button" data-testid="share-group" onClick={() => pick(groupChat(group.id), groupPath(group.id))}
                    className="w-full flex items-center gap-3 px-4 py-2.5 min-h-12 text-start hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent cursor-pointer">
                    <GroupAvatar picture={group.picture} size={36} />
                    <bdi className="min-w-0 truncate text-sm text-text-primary">{group.name}</bdi>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <button type="button" onClick={cancel} data-testid="share-cancel"
            className="px-4 py-2 min-h-10 rounded-lg text-sm border border-border text-text-secondary hover:bg-surface-hover cursor-pointer">
            {t("common.cancel")}
          </button>
        </>
      )}
    </Page>
  );
}

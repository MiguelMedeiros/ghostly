import { useEffect, useState } from "react";
import { Page } from "../components/layout";
import { ChatTargetRow } from "../components/chat/ChatTargets";
import { useChatTargets } from "../hooks/useChatTargets";
import { useI18n } from "../contexts/I18nContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { Notice } from "../components/ui/Notice";
import { dropIncomingShare, isEmptyShare, sendShareTo, shareText, useIncomingShare } from "../lib/incomingShare";

/** How long the page waits for a share that has not reached it yet before it says there is none. */
const WAIT_MS = 5000;

/**
 * "Share to…": something another app shared into Ghostly waits here for a chat. Picking one opens it with the
 * text in the draft and the files on the attachment sheet, to look over and send there; nothing is sent from
 * here. Groups take files as chats do (WISP 503).
 * A chat is never picked for the person, not even when there is only one: any website can post a share.
 */
export function SharePicker() {
  const { t } = useI18n();
  const nav = useAppNavigation();
  const share = useIncomingShare();
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), WAIT_MS);
    return () => clearTimeout(timer);
  }, []);

  const hasFiles = !!share?.files.length;
  const leftOut = share?.leftOut ?? [];
  const unread = share?.unread ?? [];
  const targets = useChatTargets();
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
          {/* Files too large to bring in (Android's share) were left out: the picker names them, and how to send them. */}
          {leftOut.length > 0 && (
            <Notice tone="error" className="text-sm" testId="share-left-out"
              title={t("pwa.shareTooLarge", { names: leftOut.join(", ") })} next={t("pwa.shareTooLargeNext")} />
          )}
          {/* Files Android could not read (a revoked permission, a broken stream): named too, never dropped silently. */}
          {unread.length > 0 && (
            <Notice tone="error" className="text-sm" testId="share-unread"
              title={t("pwa.shareUnread", { names: unread.join(", ") })} next={t("pwa.shareUnreadNext")} />
          )}
          {/* Nothing else came: no chat to pick. */}
          {!isEmptyShare(share) && (
            <>
              <div className="rounded-xl bg-surface px-4 py-3 space-y-1" data-testid="share-summary">
                {/* Any website can post to the share target, so the page says where this came from. */}
                <p className="m-0 text-xs font-medium text-text-secondary" data-testid="share-from">{t("pwa.shareFrom")}</p>
                {/* Text and names from another app read in their own direction, so English keeps its "!" at its end in Arabic.
                    A long one-word file name wraps anywhere, so its extension stays inside the card. */}
                {hasFiles && (
                  <p dir="auto" className="m-0 text-sm text-text-primary font-medium [overflow-wrap:anywhere]" data-testid="share-files">
                    {share.files.length === 1 ? share.files[0]!.name || t("pwa.shareOneFile") : t("pwa.shareFiles", { count: String(share.files.length) })}
                  </p>
                )}
                {preview && <p dir="auto" className="m-0 text-sm text-text-secondary line-clamp-3 break-words whitespace-pre-line" data-testid="share-text">{preview}</p>}
                <p className="m-0 text-xs text-text-muted">{t("pwa.shareHint")}</p>
              </div>

              {targets.length === 0 ? (
                <p className="text-sm text-text-muted">{t("pwa.shareNoChats")}</p>
              ) : (
                <ul className="rounded-xl bg-surface divide-y divide-border overflow-hidden m-0 p-0 list-none" aria-label={t("pwa.shareTitle")}>
                  {targets.map((target) => (
                    <li key={target.chat}>
                      <ChatTargetRow target={target} testId={target.kind === "group" ? "share-group" : "share-chat"} onClick={() => pick(target.chat, target.path)} />
                    </li>
                  ))}
                </ul>
              )}
            </>
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

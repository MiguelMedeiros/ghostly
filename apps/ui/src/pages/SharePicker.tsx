import { useEffect, useMemo, useRef, useState } from "react";
import { Page } from "../components/layout";
import { ChatTargetRow, ChatTargetSearch } from "../components/chat/ChatTargets";
import { useChatTargets } from "../hooks/useChatTargets";
import { useI18n } from "../contexts/I18nContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { chatTargetKeys, findChatTargets } from "../lib/chatTargets";
import { Notice } from "../components/ui/Notice";
import { SEARCH_STATUS_SETTLE_MS, SearchStatus } from "../components/ui/SearchStatus";
import { MAX_SHARE_FILES, MAX_WAITING_SHARES, dropIncomingShare, incomingShare, isEmptyShare, sendShareTo, sharePreview, useIncomingShare, type IncomingShare } from "../lib/incomingShare";

/** How long the page waits for a share that has not reached it yet before it says there is none. */
const WAIT_MS = 5000;

/**
 * "Share to…": something another app shared into Ghostly waits here for a chat. Picking one opens it with the
 * text in the draft and the files on the attachment sheet, to look over and send there; nothing is sent from
 * here. Groups take files as chats do (WISP 503).
 * A chat is never picked for the person, not even when there is only one: any website can post a share.
 * Found by name as in Forward: with a hundred contacts, the one not chatted with lately is typed, not scrolled to. The
 * search does not take the focus by itself: the picker may open on its own, and a phone's keyboard would hide the list.
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
  // A name may not be known (the web app's worker never reads a body that is too large): then it says so without one.
  const leftOutNames = leftOut.filter(Boolean);
  const noRoom = share?.noRoom ?? [];
  const pastLimit = share?.pastLimit ?? [];
  const dropped = share?.dropped ?? 0;
  const targets = useChatTargets();
  const search = useRef<HTMLInputElement>(null), list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const shown = useMemo(() => findChatTargets(targets, query), [targets, query]);
  const preview = share ? sharePreview(share) : "";
  const filesName = (shown: IncomingShare) => shown.files.length === 1 ? shown.files[0]!.name || t("pwa.shareOneFile") : t("pwa.shareFiles", { count: String(shown.files.length) });

  // Each share shown (the first, and the next in place of the one just picked or put aside): said, and not acted on before it is.
  const [said, setSaid] = useState("");
  const shownAt = useRef(0);
  const settling = () => Date.now() - shownAt.current < SEARCH_STATUS_SETTLE_MS;
  const say = (shown: IncomingShare) => isEmptyShare(shown) ? "" : [t("pwa.shareFrom"), shown.files.length ? filesName(shown) : "", sharePreview(shown)].filter(Boolean).join(" ");
  // The first share shown is said and waits as long: the picker may have opened by itself (a share forwarded to this
  // tab moves it here from any screen), under a press meant for the screen it replaced.
  if (share && !shownAt.current) {
    shownAt.current = Date.now();
    setSaid(say(share));
  }
  /**
   * Another share waited behind this one (the web app's, `receiveShare` with `queue`): the picker shows it now. The
   * focus leaves the button just pressed for the page's heading and the page is scrolled to the new share, which is
   * said once it has settled; until then a press (a key held down, a double tap) does nothing, so a share is never
   * sent or put aside before anyone saw it.
   */
  const showNext = (next: IncomingShare) => {
    shownAt.current = Date.now();
    // The next share may be for another chat: the whole list again.
    setQuery("");
    setSaid(say(next));
    document.querySelector<HTMLElement>('[data-testid="share-picker"] h1')?.focus();
    document.querySelector<HTMLElement>('[data-testid="share-picker"] [data-page-body]')?.scrollTo?.({ top: 0 });
  };

  const pick = (chat: string, path: string) => {
    if (settling()) return;
    sendShareTo(chat);
    // This one waits for its chat's composer. The last one picked opens its chat.
    const next = incomingShare();
    if (next) showNext(next);
    else nav.conversation(path);
  };
  const cancel = () => {
    if (settling()) return;
    dropIncomingShare();
    const next = incomingShare();
    if (next) showNext(next);
    else nav.home();
  };

  return (
    <Page title={t("pwa.shareTitle")} testId="share-picker">
      <SearchStatus testId="share-next" text={said} />
      {!share ? (
        <p className="text-sm text-text-muted" data-testid="share-none">{waited ? t("pwa.shareNone") : t("pwa.shareWaiting")}</p>
      ) : (
        <>
          {/* Files too large to bring in were left out: the picker names them, and how to send them. */}
          {leftOut.length > 0 && (
            <Notice tone="error" className="text-sm" testId="share-left-out"
              title={leftOutNames.length ? t("pwa.shareTooLarge", { names: leftOutNames.join(", ") }) : t("pwa.shareTooLargeUnnamed")} next={t("pwa.shareTooLargeNext")} />
          )}
          {/* Files Android could not read (a revoked permission, a broken stream): named too, never dropped silently. */}
          {unread.length > 0 && (
            <Notice tone="error" className="text-sm" testId="share-unread"
              title={t("pwa.shareUnread", { names: unread.join(", ") })} next={t("pwa.shareUnreadNext")} />
          )}
          {/* Files Android had no room to copy (the device is full): sharing again only helps once there is space. */}
          {noRoom.length > 0 && (
            <Notice tone="error" className="text-sm" testId="share-no-room"
              title={t("pwa.shareNoRoom", { names: noRoom.join(", ") })} next={t("pwa.shareNoRoomNext")} />
          )}
          {/* Files past the most one share brings were left out: named apart, as they were not too large. */}
          {pastLimit.length > 0 && (
            <Notice tone="error" className="text-sm" testId="share-past-limit"
              title={t("pwa.sharePastLimit", { count: String(MAX_SHARE_FILES), names: pastLimit.join(", ") })} next={t("pwa.sharePastLimitNext")} />
          )}
          {/* Shares that came while this one waited, past the most that can wait, were not kept: never dropped without a word. */}
          {dropped > 0 && (
            <Notice tone="error" className="text-sm" testId="share-dropped"
              title={dropped === 1 ? t("pwa.shareDroppedOne", { waiting: String(MAX_WAITING_SHARES) }) : t("pwa.shareDropped", { count: String(dropped), waiting: String(MAX_WAITING_SHARES) })}
              next={t("pwa.shareDroppedNext")} />
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
                    {filesName(share)}
                  </p>
                )}
                {preview && <p dir="auto" className="m-0 text-sm text-text-secondary line-clamp-3 break-words whitespace-pre-line" data-testid="share-text">{preview}</p>}
                <p className="m-0 text-xs text-text-muted">{t("pwa.shareHint")}</p>
              </div>

              {targets.length === 0 ? (
                <p className="text-sm text-text-muted">{t("pwa.shareNoChats")}</p>
              ) : (
                <>
                  <ChatTargetSearch inputRef={search} list={list} testId="share-search" value={query} onChange={setQuery} />
                  <SearchStatus testId="share-found" text={!query.trim() ? "" : shown.length ? t("chat.forward.found", { count: shown.length }) : t("chat.forward.noMatch")} />
                </>
              )}
              {targets.length > 0 && shown.length === 0 && <p className="text-sm text-text-muted" data-testid="share-no-match">{t("chat.forward.noMatch")}</p>}
              {shown.length > 0 && (
                <ul ref={list} onKeyDown={chatTargetKeys(search)} className="rounded-xl bg-surface divide-y divide-border overflow-hidden m-0 p-0 list-none" aria-label={t("pwa.shareTitle")}>
                  {shown.map((target) => (
                    <li key={target.chat}>
                      <ChatTargetRow target={target} testId={target.kind === "group" ? "share-group" : "share-chat"} onClick={() => pick(target.chat, target.path)} />
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          <button type="button" onClick={cancel} data-testid="share-cancel"
            className="px-4 py-2 min-h-10 max-md:min-h-11 rounded-lg text-sm border border-border text-text-secondary hover:bg-surface-hover cursor-pointer">
            {t("common.cancel")}
          </button>
        </>
      )}
    </Page>
  );
}

import { useMemo, useRef, useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { SavedMessage } from "@ghostly/browser/shared/types";
import { PageHeader } from "../components/layout";
import { SavedIcon } from "../components/saved/SavedIcon";
import { useI18n } from "../contexts/I18nContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { useChatTargets, type ChatTarget } from "../hooks/useChatTargets";
import { JUMP_TO } from "../hooks/useJumpTo";
import { useMinuteClock } from "../hooks/useMinuteClock";
import { setSaved, useSavedMessages, useSavedRead } from "../hooks/useSavedMessages";
import { filePreview, formatListTime, previewText } from "../lib/chatList";
import { authorName, groupPath } from "../lib/groups";

/*
 * Saved messages: the messages this profile saved, from all its chats and groups, the last saved first. Kept on this
 * device only (`savedMessages`), never sent. A row says where the message is, who wrote it and when, and opens its chat
 * on it; its own button unsaves it. An edit shows its latest text; a deleted message is gone from here too.
 */

const subscribeEngine = (listener: () => void) => engine.subscribe(listener);
const engineGroups = () => engine.state?.groups;

interface SavedRow { saved: SavedMessage; chat: string; path?: string; author: string; text: string }

export function Saved() {
  const { t, language } = useI18n();
  const nav = useAppNavigation();
  const pageRef = useRef<HTMLDivElement>(null);
  const now = useMinuteClock(pageRef);
  const saved = useSavedMessages();
  const read = useSavedRead();
  const targets = useChatTargets();
  const groups = useSyncExternalStore(subscribeEngine, engineGroups);

  const rows = useMemo(() => {
    const byTarget = new Map<string, ChatTarget>(targets.flatMap((target) => target.target ? [[target.target, target]] : []));
    return saved.flatMap((s): SavedRow[] => {
      const { message } = s, target = byTarget.get(message.linkId);
      // A voice message or a video in this app's language, as the chat list says it: the history keeps it in English.
      const text = filePreview(message.file, t) ?? (previewText(message.text, t) || message.file?.name || t("saved.noText"));
      if (message.linkId.startsWith("group:")) {
        // A group this device cannot write in is not a target of a forward, and still has its saved messages.
        const group = groups?.find((g) => `group:${g.id}` === message.linkId);
        if (!group) return [];
        const author = message.sender === "me" ? t("saved.you") : message.member ? authorName(group, message.member, t) : group.name;
        return [{ saved: s, chat: group.name || t("group.chat.unnamed"), path: groupPath(group.id), author, text }];
      }
      if (!target) return [];
      return [{ saved: s, chat: target.name, path: target.path, author: message.sender === "me" ? t("saved.you") : target.name, text }];
    });
  }, [saved, targets, groups, t]);

  const open = (row: SavedRow) => { if (row.path) nav.conversation(row.path, { [JUMP_TO]: row.saved.message.id }); };

  return (
    <div ref={pageRef} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-chat-bg" data-testid="saved-page">
      <PageHeader title={t("saved.title")} />
      {read && !rows.length ? (
        <div data-testid="saved-empty" className="flex flex-1 flex-col items-center justify-center gap-1 px-8 text-center">
          <SavedIcon size={40} strokeWidth={1.5} className="mb-2 text-text-muted" />
          <p className="m-0 text-sm text-text-secondary">{t("saved.empty")}</p>
          <p className="m-0 text-xs text-text-muted">{t("saved.emptyHint")}</p>
        </div>
      ) : (
        <ul data-testid="saved-list" aria-label={t("saved.title")} className="m-0 flex-1 list-none divide-y divide-border overflow-y-auto p-0">
          {rows.map((row) => {
            const { message } = row.saved;
            const time = formatListTime(message.timestamp, now, language, t);
            return (
              <li key={`${message.linkId}\n${message.id}`} data-testid="saved-row" data-message-id={message.id} className="flex items-stretch">
                <button type="button" data-testid="saved-open" onClick={() => open(row)} aria-label={t("saved.open", { chat: row.chat, text: row.text })}
                  className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 px-4 py-2.5 text-start hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent max-md:min-h-14">
                  <span className="flex min-w-0 items-baseline gap-2 text-xs text-text-muted">
                    <bdi data-testid="saved-chat" className="min-w-0 truncate font-medium text-text-secondary">{row.chat}</bdi>
                    {row.author !== row.chat && <bdi data-testid="saved-author" className="min-w-0 truncate">{row.author}</bdi>}
                    <span className="ms-auto shrink-0 tabular-nums">{time}</span>
                  </span>
                  <bdi data-testid="saved-text" className="line-clamp-2 text-sm text-text-primary">{row.text}</bdi>
                </button>
                <button type="button" data-testid="saved-unsave" onClick={() => void setSaved(message.linkId, message.id, true)} aria-label={t("saved.unsave")} title={t("saved.unsave")}
                  className="grid w-12 shrink-0 cursor-pointer place-items-center text-accent hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent">
                  <SavedIcon size={18} filled />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

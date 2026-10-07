import { useRef } from "react";
import type { InstalledAppView } from "@ghostly/browser/engine/apps";
import { useBackdropDismiss, useDialogFocus } from "../../hooks/useDismiss";
import { useI18n } from "../../contexts/I18nContext";
import { useAppNavigation } from "../../hooks/useAppNavigation";
import { useChatTargets } from "../../hooks/useChatTargets";
import { listSessions } from "../../lib/storage";
import { requestOpenInChat } from "../../lib/apps/running";
import type { OpenAppOptions } from "../../lib/apps/open";
import { ChatTargetRow } from "../chat/ChatTargets";
import { Button } from "../wallet/ui";

/*
 * Open on the Apps page for an app that runs in a chat (its manifest's `view` is `chat`, WISP 1200 § Manifest): which
 * 1:1 chat to open it in, most recent first, from the same list Forward and Share use. Picking one goes to that chat,
 * which opens the app there as its own + → Apps does (the contact gets the "opened" card). Groups never: apps run in
 * 1:1 chats.
 */
export function AppChatPicker({ app, options, onClose }: { app: InstalledAppView; options?: OpenAppOptions; onClose: () => void }) {
  const { t } = useI18n();
  const nav = useAppNavigation();
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, onClose);
  const backdrop = useBackdropDismiss(onClose);
  const all = useChatTargets({ files: true });
  // A paired 1:1 chat with its link: where an app's panel is.
  const paired = new Set(listSessions().filter((s) => s.profile === "paired-chat/1").map((s) => s.id));
  const targets = all.filter((target) => target.kind === "chat" && !!target.target && paired.has(target.chat));

  const pick = (linkId: string, path: string) => {
    requestOpenInChat(linkId, { app, ...(options && { options }) });
    onClose();
    nav.conversation(path);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 sm:p-4 animate-fade-in" {...backdrop}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="app-chat-picker-title" data-testid="app-chat-picker"
        className="focus:outline-none w-full sm:max-w-md bg-panel-header border border-border rounded-t-2xl sm:rounded-2xl shadow-2xl p-5 space-y-4 max-h-[85dvh] overflow-y-auto pb-safe">
        <div>
          <h2 id="app-chat-picker-title" className="text-lg font-medium text-text-primary">{t("apps.pick.title", { title: app.title })}</h2>
          <p className="text-xs text-text-secondary mt-1">{t("apps.pick.hint")}</p>
        </div>
        {targets.length === 0
          ? <p className="text-sm text-text-muted" data-testid="app-chat-picker-none">{t("apps.pick.none")}</p>
          : (
            <ul className="rounded-xl bg-surface divide-y divide-border overflow-hidden m-0 p-0 list-none" aria-labelledby="app-chat-picker-title">
              {targets.map((target) => (
                <li key={target.chat}>
                  <ChatTargetRow target={target} testId="app-chat-picker-chat" onClick={() => pick(target.target!, target.path)} />
                </li>
              ))}
            </ul>
          )}
        <div className="flex justify-end">
          <Button onClick={onClose}>{t("common.cancel")}</Button>
        </div>
      </div>
    </div>
  );
}

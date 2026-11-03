import type { SyntheticEvent } from "react";
import { useI18n } from "../../contexts/I18nContext";
import type { MessageCopyNote as Note } from "../../hooks/useMessageCopy";
import { Notice } from "../ui/Notice";

/**
 * What Copy under a long press said (hooks/useMessageCopy.ts), under the message: "Copied", or a refusal with the text in
 * a field, where a touch screen still selects it (a message's own words are not selectable there).
 */
export function MessageCopyNote({ note }: { note: Note | null }) {
  const { t } = useI18n();
  if (!note) return null;
  if (note.said === "copied") return <p role="status" data-testid="message-copied" className="m-0 max-w-full px-1 pt-1 text-[11px] text-accent">{t("chat.message.copied")}</p>;
  // A long press on the field is the system's selection, not the message's quick bar.
  const own = (e: SyntheticEvent) => e.stopPropagation();
  return (
    <div className="w-full max-w-full px-1 pt-1 space-y-1" onPointerDown={own} onContextMenu={own} onDoubleClick={own}>
      <Notice tone="error" testId="message-copy-error" className="text-[11px]">{t("chat.message.copyFailed")}</Notice>
      <textarea readOnly dir="auto" rows={3} value={note.text} data-testid="message-copy-text" aria-label={t("chat.message.copyText")}
        className="block w-full resize-none rounded-lg bg-black/20 p-2 text-xs text-inherit focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
    </div>
  );
}

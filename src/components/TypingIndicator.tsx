import { useI18n } from "../contexts/I18nContext";
import { usePeerTyping } from "../hooks/useTyping";

/** Three dots in a soft wave; still, and all shown, when motion is reduced (index.css `.typing-dots`). */
export function TypingDots() {
  return <span className="typing-dots" aria-hidden="true"><span /><span /><span /></span>;
}

/**
 * "typing…" where a chat says its contact is writing (WISP 401 § Typing): the header's subtitle and the chat list's
 * preview line. Presence, not connection: it never takes the connection icon's place.
 */
export function TypingText({ testId, className = "" }: { testId: string; className?: string }) {
  const { t } = useI18n();
  return (
    <span data-testid={testId} className={`inline-flex items-center gap-1.5 text-accent ${className}`}>
      <TypingDots />
      <span>{t("chat.typing")}</span>
    </span>
  );
}

/**
 * The chat header's second line: the contact's key, or "typing…" while they write. `peerKey` only for a paired 1:1
 * chat (the others never show typing). Everything about the connection stays in the icon beside the calls.
 */
export function ChatSubtitle({ peerKey, keyLabel }: { peerKey?: string; keyLabel: string }) {
  const typing = usePeerTyping(peerKey);
  return (
    <p className={`m-0 truncate text-xs max-md:text-[10px] whitespace-nowrap ${typing ? "" : "text-text-muted/60 font-mono"}`} data-testid="chat-subtitle"
      role="status" aria-live="polite">
      {typing ? <TypingText testId="chat-typing" /> : keyLabel}
    </p>
  );
}

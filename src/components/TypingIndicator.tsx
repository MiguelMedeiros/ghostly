import type { TypingActivity } from "@ghostly/core";
import { useI18n } from "../contexts/I18nContext";
import { usePeerTypingActivity } from "../hooks/useTyping";

/** Three dots in a soft wave; still, and all shown, when motion is reduced (index.css `.typing-dots`). */
export function TypingDots() {
  return <span className="typing-dots" aria-hidden="true"><span /><span /><span /></span>;
}

const LABELS = { typing: "chat.typing", recording: "chat.typingRecording", thinking: "chat.typingThinking" } as const;

/**
 * "typing…", "recording audio…", "thinking…" or a bot's own status line where a chat says what its contact is doing
 * (WISP 401 § Typing): the header's subtitle and the chat list's preview line. Presence, not connection: it never
 * takes the connection icon's place. A status is plain text from the contact, already one short line (the engine
 * cleans it); it is isolated so its direction cannot turn the line around it.
 */
export function TypingText({ testId, activity, className = "" }: { testId: string; activity?: TypingActivity | null; className?: string }) {
  const { t } = useI18n();
  const kind = activity?.kind ?? "typing";
  return (
    <span data-testid={testId} data-kind={kind} className={`inline-flex min-w-0 items-center gap-1.5 text-accent ${className}`}>
      <TypingDots />
      {activity?.status
        ? <bdi data-testid={`${testId}-status`} className="truncate">{activity.status}</bdi>
        : <span className="truncate">{t(LABELS[kind] ?? LABELS.typing)}</span>}
    </span>
  );
}

/**
 * The chat header's second line: the contact's key, or what the contact is doing while it lasts. `peerKey` only for a
 * paired 1:1 chat (the others never show typing). Everything about the connection stays in the icon beside the calls.
 */
export function ChatSubtitle({ peerKey, keyLabel }: { peerKey?: string; keyLabel: string }) {
  const activity = usePeerTypingActivity(peerKey);
  return (
    <p className={`m-0 truncate text-xs max-md:text-[10px] whitespace-nowrap ${activity ? "" : "text-text-muted/60 font-mono"}`} data-testid="chat-subtitle"
      role="status" aria-live="polite">
      {activity ? <TypingText testId="chat-typing" activity={activity} /> : keyLabel}
    </p>
  );
}

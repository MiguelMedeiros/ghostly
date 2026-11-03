import type { KeyboardEvent, RefObject } from "react";
import { useI18n } from "../../contexts/I18nContext";
import type { ChatTarget } from "../../hooks/useChatTargets";
import { chatTargetRows } from "../../lib/chatTargets";

/**
 * One chat in a picker: its picture and name, and for a choice of several, whether it is chosen. `disabled`: it cannot
 * be chosen now (the picker has as many as it takes).
 */
export function ChatTargetRow({ target, testId, onClick, checked, disabled }: {
  target: ChatTarget; testId: string; onClick: () => void; checked?: boolean; disabled?: boolean;
}) {
  const multi = checked !== undefined;
  return (
    <button type="button" data-testid={testId} data-kind={target.kind} onClick={onClick} disabled={disabled}
      {...(multi && { role: "checkbox", "aria-checked": checked })}
      className="w-full flex items-center gap-3 px-4 py-2.5 min-h-12 text-start hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent cursor-pointer disabled:opacity-50 disabled:cursor-default">
      {target.kind === "chat"
        ? <span className="relative w-9 h-9 shrink-0 overflow-hidden rounded-full flex items-center justify-center bg-surface-hover">{target.avatar}</span>
        : target.avatar}
      <bdi className="min-w-0 flex-1 truncate text-sm text-text-primary">{target.name}</bdi>
      {multi && (
        <span aria-hidden="true" className={`w-5 h-5 shrink-0 rounded-full border-2 flex items-center justify-center ${checked ? "bg-accent border-accent text-on-accent" : "border-text-muted"}`}>
          {checked && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg>}
        </span>
      )}
    </button>
  );
}

/**
 * A picker's search by name (Forward, Open an app in a chat), in Forward's words. The down arrow goes on to the first
 * chat it found; the list it filters takes `chatTargetKeys` for the rest.
 */
export function ChatTargetSearch({ inputRef, list, value, onChange, testId }: {
  inputRef: RefObject<HTMLInputElement | null>;
  /** The list of the chats it found. */
  list: RefObject<HTMLElement | null>;
  value: string;
  onChange(value: string): void;
  testId: string;
}) {
  const { t } = useI18n();
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "ArrowDown") return;
    const first = chatTargetRows(list.current)[0];
    if (!first) return;
    e.preventDefault();
    first.focus();
  };
  return (
    <input ref={inputRef} type="search" data-testid={testId} value={value} onChange={e => onChange(e.target.value)} onKeyDown={keys}
      placeholder={t("chat.forward.search")} aria-label={t("chat.forward.search")}
      className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-muted outline-none focus-visible:ring-2 focus-visible:ring-focus-ring" />
  );
}

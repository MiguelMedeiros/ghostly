import type { ChatTarget } from "../../hooks/useChatTargets";

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

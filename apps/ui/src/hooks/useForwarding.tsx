import { useEffect, useState, type ReactNode } from "react";
import { useI18n } from "../contexts/I18nContext";
import { ForwardDialog } from "../components/chat/ForwardDialog";
import { FORWARD_MAX_MESSAGES, canForward } from "../lib/forward";
import type { ChatMessage } from "../lib/types";

/** What a chat's rows get from forwarding: Forward and Select in their ⋮, or a checkbox while messages are chosen. */
export interface ForwardRowProps {
  onForward?: () => void;
  onSelect?: () => void;
  selection?: { selected: boolean; onToggle?: () => void };
}

/**
 * Forwarding in a chat or a group (WISP 400 § Forwards): one message from its ⋮, or several chosen first (Select, then
 * Forward), as WhatsApp does. While messages are chosen, `bar` takes the composer's place; Escape or ✕ ends it.
 * `from`: the engine's id of the chat (a link id, or `group:<id>`); without one, nothing is offered.
 */
export function useForwarding(from: string | undefined, messages: readonly ChatMessage[]): {
  rowProps(message: ChatMessage): ForwardRowProps;
  selecting: boolean;
  bar: ReactNode;
  dialog: ReactNode;
} {
  const { t } = useI18n();
  const [selected, setSelected] = useState<string[] | null>(null);
  const [forwarding, setForwarding] = useState<ChatMessage[] | null>(null);
  // Another chat, or this one left: nothing stays chosen.
  useEffect(() => { setSelected(null); setForwarding(null); }, [from]);
  useEffect(() => {
    if (!selected || forwarding) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSelected(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, forwarding]);

  const toggle = (id: string) => setSelected(now => {
    if (!now) return [id];
    if (now.includes(id)) { const rest = now.filter(x => x !== id); return rest.length ? rest : null; }
    return now.length >= FORWARD_MAX_MESSAGES ? now : [...now, id];
  });
  const chosen = () => messages.filter(m => selected?.includes(m.id)).sort((a, b) => a.timestamp - b.timestamp);

  const rowProps = (message: ChatMessage): ForwardRowProps => {
    if (!from) return {};
    const can = canForward(message);
    if (selected) return { selection: { selected: selected.includes(message.id), ...(can && { onToggle: () => toggle(message.id) }) } };
    return can ? { onForward: () => setForwarding([message]), onSelect: () => setSelected([message.id]) } : {};
  };

  const count = selected?.length ?? 0;
  const bar = selected && (
    <div data-testid="select-bar" role="toolbar" aria-label={t("chat.forward.selected", { count: String(count) })}
      className="flex items-center gap-3 px-4 py-2 min-h-[62px] bg-panel-header border-t border-border">
      <button type="button" data-testid="select-cancel" onClick={() => setSelected(null)} title={t("common.cancel")} aria-label={t("common.cancel")}
        className="p-2 rounded-full text-text-secondary hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent cursor-pointer">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
      <span data-testid="select-count" className="flex-1 text-sm text-text-primary" aria-live="polite">{t("chat.forward.selected", { count: String(count) })}</span>
      <button type="button" data-testid="select-forward" onClick={() => setForwarding(chosen())} disabled={!count}
        className="inline-flex items-center gap-2 min-h-10 rounded-lg bg-accent px-4 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-accent cursor-pointer">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="rtl:-scale-x-100"><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5 5.5 5.5 0 0 0 9.5 20H13" /></svg>
        {t("chat.forward.forward")}
      </button>
    </div>
  );
  const dialog = from && forwarding && (
    <ForwardDialog from={from} messages={forwarding} onClose={() => setForwarding(null)} onSent={() => setSelected(null)} />
  );
  return { rowProps, selecting: !!selected, bar, dialog };
}

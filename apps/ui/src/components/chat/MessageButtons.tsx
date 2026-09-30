import { useEffect, useState } from "react";
import type { CardButton } from "@ghostly/core";
import { engine } from "@ghostly/browser/platform/engine";
import { useI18n } from "../../contexts/I18nContext";
import type { ButtonsView } from "../../lib/buttons";
import { jumpToQuoted } from "../../lib/replies";

/*
 * A bot's buttons under its message (WISP 4xx · Message Buttons). A tap sends a reply whose text is the button's
 * label (the engine's `pressButton`); the one chosen (the bot's word, else my last press) is marked with ✓. Closed, or
 * answered with a `once` button, or my own message: they are shown, and none of them answers.
 */

/** How long "Couldn't send" stays under the buttons. */
const ERROR_MS = 4000;

/** Two in a row share it; three, five or six go three to a row; four, two by two. A last row's buttons fill it. */
function basis(count: number): string {
  if (count === 1) return "basis-full";
  return count === 2 || count === 4 ? "basis-[calc(50%-0.1875rem)]" : "basis-[calc(33.333%-0.25rem)]";
}

export function MessageButtons({ view, messageId, linkId }: { view: ButtonsView; messageId: string; linkId?: string }) {
  const { t } = useI18n();
  const { card } = view;
  /** The button being sent, and the last one sent from here (until the chat's history says so too). */
  const [busy, setBusy] = useState<string>();
  const [local, setLocal] = useState<string>();
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(false), ERROR_MS);
    return () => clearTimeout(timer);
  }, [error]);
  const chosen = card.chosen ?? local ?? view.chosen;
  // A `once` button pressed here closes them at once, before my reply is in the history.
  const open = !!linkId && view.open && !card.closed && !(local && card.buttons.find(b => b.id === local)?.once);
  const press = async (button: CardButton) => {
    if (!open || busy) return;
    setBusy(button.id);
    setError(false);
    try {
      const result = await engine.call("pressButton", { linkId, messageId, buttonId: button.id });
      // A second tap within a second of the last is simply not taken: nothing failed.
      if (result.error) { if (!result.paced) setError(true); }
      else setLocal(button.id);
    } catch {
      setError(true);
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <div className="mt-1 w-full min-w-48">
      <div role="group" aria-label={t("cards.buttons.answers")} data-testid="message-buttons" data-open={open || undefined}
        onDoubleClick={(e) => e.stopPropagation()}
        className="flex flex-wrap gap-1.5">
        {card.buttons.map(button => {
          const style = button.style ?? "neutral";
          const isChosen = chosen === button.id;
          const sending = busy === button.id;
          const off = !open || !!busy;
          return (
            <button key={button.id} type="button" data-testid="message-button" data-button-id={button.id} data-style={style}
              data-chosen={isChosen || undefined} aria-pressed={isChosen} aria-disabled={off || undefined} aria-busy={sending || undefined}
              title={sending ? t("cards.buttons.sending") : isChosen ? t("cards.buttons.chosen") : undefined}
              onClick={(e) => { e.stopPropagation(); void press(button); }}
              className={`message-button inline-flex min-h-10 min-w-0 grow ${basis(card.buttons.length)} items-center justify-center gap-1.5 rounded-[10px] px-3 py-1.5 text-center text-[13.5px] font-medium leading-tight wrap-break-word transition-[background-color,opacity] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-chat-bg ${off ? "cursor-default" : "cursor-pointer"} ${sending ? "opacity-70" : ""} ${isChosen ? "font-semibold" : ""}`}>
              {sending
                ? <span aria-hidden="true" className="size-3 shrink-0 animate-spin rounded-full border-2 border-current border-e-transparent motion-reduce:animate-none" />
                : isChosen && <span aria-hidden="true" data-testid="message-button-check">✓</span>}
              <span dir="auto" className="min-w-0">{button.label}</span>
            </button>
          );
        })}
      </div>
      {(error || card.closed) && (
        <p role={error ? "alert" : undefined} data-testid={error ? "message-buttons-error" : "message-buttons-closed"}
          className={`mt-1 px-1 text-[11.5px] leading-4 ${error ? "text-danger-ink" : "text-text-muted"}`}>
          {error ? t("cards.buttons.failed") : t("cards.buttons.closed")}
        </p>
      )}
    </div>
  );
}

/**
 * A reply that is a button press, as "↩ Yes": the label, and a tap goes to the question (as a reply's quote does).
 * `targetId`: the question's row here; without it the line is only the label.
 */
export function ButtonPress({ label, targetId }: { label: string; targetId?: string }) {
  const { t } = useI18n();
  const body = <>
    <span aria-hidden="true" className="inline-block text-text-muted rtl:-scale-x-100">↩</span>{" "}
    <span dir="auto" data-testid="button-press-label">{label}</span>
  </>;
  if (!targetId) return <span data-testid="button-press" className="text-[14.2px] leading-[19px] wrap-break-word">{body}</span>;
  return (
    <button type="button" data-testid="button-press" data-target={targetId} title={t("cards.buttons.jump")}
      onClick={(e) => { e.stopPropagation(); jumpToQuoted(targetId); }}
      onDoubleClick={(e) => e.stopPropagation()}
      className="cursor-pointer rounded text-start text-[14.2px] leading-[19px] wrap-break-word hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
      {body}
    </button>
  );
}

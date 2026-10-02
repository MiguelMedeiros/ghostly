import { useEffect, useState } from "react";
import { useI18n } from "../../contexts/I18nContext";
import { jumpToQuoted, type QuoteView } from "../../lib/replies";
import { useMemberText } from "../../contexts/MemberColorsContext";

/** How long "not in this chat" stays under a quote whose original cannot be shown. */
const NOT_HERE_MS = 3000;

/** The coloured bar, the name and the line: the same look above a bubble's text and above the composer. */
function QuoteBody({ name, snippet, mine, member, note, italic }: { name?: string; snippet: string; mine: boolean; member?: string; note?: string; italic?: boolean }) {
  const memberText = useMemberText();
  // A group member's original: their colour, on the bar and the name (lib/memberColors.ts).
  const colour = member && !mine ? memberText(member) : undefined;
  return (
    <span className={`flex min-w-0 flex-col border-s-4 ps-2 pe-1 py-1 ${mine ? "border-accent" : colour ? `border-current ${colour}` : "border-link"}`}>
      {name && <span data-testid="reply-quote-name" data-key={colour && member} className={`truncate text-[12.8px] font-medium leading-[18px] ${mine ? "text-accent-hover" : colour ?? "text-link"}`}>{name}</span>}
      <span data-testid="reply-quote-snippet" dir="auto" className={`truncate text-[13px] leading-[18px] text-text-primary/70 ${italic ? "italic" : ""}`}>{snippet}</span>
      {note && <span data-testid="reply-quote-note" className="truncate text-[11px] leading-[15px] text-text-muted">{note}</span>}
    </span>
  );
}

/**
 * The quoted message above a reply's text. A tap scrolls to the original and marks it for a moment; one that is not
 * in this chat says so instead. A line the original here did not confirm is marked as the replier's app's word.
 */
export function ReplyQuote({ quote }: { quote: QuoteView }) {
  const { t } = useI18n();
  const [notHere, setNotHere] = useState(false);
  useEffect(() => {
    if (!notHere) return;
    const timer = setTimeout(() => setNotHere(false), NOT_HERE_MS);
    return () => clearTimeout(timer);
  }, [notHere]);
  const snippet = quote.state === "deleted" ? t("chat.reply.deleted") : quote.state === "missing" ? t("chat.reply.unavailable") : quote.snippet;
  const note = notHere ? t("chat.reply.notHere") : quote.state === "unverified" ? t("chat.reply.unverified") : undefined;
  return (
    <button type="button" data-testid="message-quote" data-state={quote.state} data-target={quote.targetId}
      onClick={(e) => {
        // The bubble's own double click opens its details: a tap on the quote is only the jump.
        e.stopPropagation();
        if (!jumpToQuoted(quote.targetId)) setNotHere(true);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      title={quote.state === "found" ? t("chat.reply.jump") : undefined}
      className="mb-1 flex w-full min-w-0 cursor-pointer overflow-hidden rounded-md bg-text-primary/5 text-start hover:bg-text-primary/10 transition-colors">
      <QuoteBody name={quote.name} snippet={snippet} mine={quote.mine} member={quote.member} note={note} italic={quote.state === "deleted" || quote.state === "missing"} />
    </button>
  );
}

/** The message being edited (WISP 400 § Edits), above the composer's field, with ✕ to leave it as it is (Escape does it too). */
export function EditBar({ snippet, onCancel }: { snippet: string; onCancel: () => void }) {
  const { t } = useI18n();
  return (
    <div data-testid="composer-edit" role="status" aria-label={t("chat.edit.editing")}
      className="mb-2 flex items-stretch gap-1 overflow-hidden rounded-lg bg-surface-alt animate-fade-in">
      <span className="min-w-0 flex-1"><QuoteBody name={t("chat.edit.editing")} snippet={snippet} mine /></span>
      <button type="button" data-testid="composer-edit-cancel" onClick={onCancel} aria-label={t("chat.edit.cancel")} title={t("chat.edit.cancel")}
        className="shrink-0 w-9 flex items-center justify-center text-text-muted hover:text-text-primary cursor-pointer bg-transparent border-0 text-lg leading-none">
        &times;
      </button>
    </div>
  );
}

/** The message being answered, above the composer's field, with ✕ to answer nothing after all (Escape does it too). */
export function ReplyBar({ name, snippet, mine, member, onCancel }: { name?: string; snippet: string; mine: boolean; member?: string; onCancel: () => void }) {
  const { t } = useI18n();
  return (
    <div data-testid="composer-reply" role="status" aria-label={t("chat.reply.replyingTo", { name: name ?? "" })}
      className="mb-2 flex items-stretch gap-1 overflow-hidden rounded-lg bg-surface-alt animate-fade-in">
      <span className="min-w-0 flex-1"><QuoteBody name={name} snippet={snippet} mine={mine} member={member} /></span>
      <button type="button" data-testid="composer-reply-cancel" onClick={onCancel} aria-label={t("chat.reply.cancel")} title={t("chat.reply.cancel")}
        className="shrink-0 w-9 flex items-center justify-center text-text-muted hover:text-text-primary cursor-pointer bg-transparent border-0 text-lg leading-none">
        &times;
      </button>
    </div>
  );
}

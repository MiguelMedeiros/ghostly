import { useId, useState, type ReactNode } from "react";
import { useI18n } from "../../contexts/I18nContext";
import type { ChatSearch } from "../../hooks/useChatSearch";
import { matchRanges } from "../../lib/chatSearch";
import { useComposition } from "../../hooks/useComposition";

/** `text` with the places that hold `term` marked; the text itself when there is no term or no match. */
export function Highlight({ text, term }: { text: string; term?: string }) {
  const ranges = term ? matchRanges(text, term) : [];
  if (!ranges.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [from, to] of ranges) {
    if (from > at) parts.push(text.slice(at, from));
    parts.push(<mark key={from} data-search-match className="rounded-[2px] bg-accent/35 text-inherit">{text.slice(from, to)}</mark>);
    at = to;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

const icon = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;
/** A magnifier: the search's own, and its row in a chat's ⋮. */
export function SearchIcon({ className }: { className?: string }) {
  return <svg {...icon} className={className}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>;
}

const button ="shrink-0 grid place-items-center w-8 h-8 max-md:w-10 max-md:h-10 rounded-full text-text-secondary enabled:hover:text-accent enabled:hover:bg-surface-hover disabled:opacity-40 transition-colors cursor-pointer disabled:cursor-default";

/**
 * The bar under a chat's header while its search is open (useChatSearch): the words, how many messages hold them and
 * which one is shown, ↑ for an older match and ↓ for a newer one (Enter and Shift+Enter), ✕ or Escape to close (the focus
 * goes back to what had it before).
 */
export function ChatSearchBar({ search }: { search: ChatSearch }) {
  const { t } = useI18n();
  const [info, setInfo] = useState(false);
  const infoId = useId();
  const composition = useComposition();
  if (!search.open) return null;
  const total = search.results.length;
  const searched = !!search.term.trim() && search.term === search.query;
  const more = t("common.moreInfo");
  return (
    <div data-testid="chat-search" className="shrink-0 border-b border-border bg-panel-header px-3 py-1.5 max-md:px-2">
      <div role="search" className="flex items-center gap-1">
        <SearchIcon className="shrink-0 text-text-muted" />
        <input
          ref={search.inputRef}
          autoFocus
          type="search"
          data-testid="chat-search-input"
          value={search.query}
          onChange={(e) => search.setQuery(e.target.value)}
          {...composition.inputProps}
          onKeyDown={(e) => {
            if (composition.composing(e)) return;
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); search.dismiss(); }
            else if (e.key === "Enter") { e.preventDefault(); if (e.shiftKey) search.newer(); else search.older(); }
          }}
          placeholder={t("chat.search.placeholder")}
          aria-label={t("chat.search.placeholder")}
          className="min-w-0 flex-1 rounded-md bg-transparent px-1.5 py-1 text-sm text-text-primary placeholder:text-text-muted outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring [&::-webkit-search-cancel-button]:hidden"
        />
        <span data-testid="chat-search-count" role="status" aria-live="polite" className="shrink-0 px-1 text-xs tabular-nums text-text-muted">
          {searched ? (total ? t("chat.search.count", { current: String(Math.max(search.index, 0) + 1), total: String(total) }) : t("chat.search.none")) : ""}
        </span>
        <button type="button" data-testid="chat-search-info" aria-expanded={info} aria-controls={infoId} aria-label={more} title={more} onClick={() => setInfo(!info)}
          className={`${button} aria-expanded:text-accent`}>
          <svg {...icon} width={15} height={15}><circle cx="12" cy="12" r="9.5" /><path d="M12 11v5.5M12 7.5v.01" /></svg>
        </button>
        <button type="button" data-testid="chat-search-older" disabled={!total} onClick={search.older} aria-label={t("chat.search.older")} title={t("chat.search.older")} className={button}>
          <svg {...icon}><path d="m18 15-6-6-6 6" /></svg>
        </button>
        <button type="button" data-testid="chat-search-newer" disabled={!total} onClick={search.newer} aria-label={t("chat.search.newer")} title={t("chat.search.newer")} className={button}>
          <svg {...icon}><path d="m6 9 6 6 6-6" /></svg>
        </button>
        <button type="button" data-testid="chat-search-close" onClick={search.dismiss} aria-label={t("chat.search.close")} title={t("chat.search.close")} className={button}>
          <svg {...icon}><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>
      {info && <p id={infoId} data-testid="chat-search-info-text" className="m-0 mt-1 ps-7 text-xs leading-relaxed text-text-secondary">{t("chat.search.info")}</p>}
    </div>
  );
}

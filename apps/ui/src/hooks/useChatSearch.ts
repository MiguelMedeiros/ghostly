import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { searchable, searchMessages } from "../lib/chatSearch";
import { jumpToMessage } from "../lib/replies";
import type { Translate } from "../locales/translate";
import type { ChatMessage } from "../lib/types";
import { revealMessage } from "./useRowWindow";

/** How long typing rests before the chat is searched: a long chat is searched once per pause, not once per key. */
export const SEARCH_DEBOUNCE_MS = 150;

/** Scrolls to a message and marks it, as a quote's tap does, bringing the rows around it in first when it is not in the page. */
function jump(id: string) {
  if (!jumpToMessage(id) && revealMessage(id)) jumpToMessage(id);
}

/**
 * Search inside a chat (apps/ui/src/lib/chatSearch.ts): its messages as this device keeps them, never the page's text, so a
 * chat of thousands of messages answers as fast as a short one. Ctrl/Cmd+F opens it while `active` (the chat on
 * screen), Escape in its field closes it, another chat closes it. The newest match comes first; `older` and `newer`
 * go through the rest, round, each one scrolled to and marked. Put away (Escape, ✕), it gives the focus back to what had
 * it as it opened (the composer, for Ctrl/Cmd+F there), or to `returnFocus` (the chat's ⋮, whose row went with its menu).
 */
export function useChatSearch({ messages, chat, active, t, returnFocus }: { messages: readonly ChatMessage[]; chat: string; active: boolean; t?: Translate; returnFocus?: RefObject<HTMLElement | null> }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [term, setTerm] = useState("");
  const [current, setCurrent] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** What had the focus as the search opened, to have it back: not a menu's row (it goes with the menu), not the bar. */
  const before = useRef<HTMLElement | null>(null);

  const close = useCallback(() => { setOpen(false); setQuery(""); setTerm(""); setCurrent(null); }, []);
  const show = useCallback(() => {
    const at = document.activeElement;
    const bar = inputRef.current?.closest("[data-testid=chat-search]");
    if (!bar?.contains(at)) before.current = at instanceof HTMLElement && at !== document.body && !at.closest("[data-menu]") ? at : null;
    setOpen(true);
    // Already open: back to its field, the words in it chosen, so typing replaces them.
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); });
  }, []);

  /**
   * Closed by the person (Escape, ✕): the focus goes back where it was, so the keys go on from there. Before, it fell to
   * the page. Focus that went somewhere else meanwhile (a click in the chat) stays there.
   */
  const dismiss = useCallback(() => {
    const at = document.activeElement;
    const inside = !at || at === document.body || !!inputRef.current?.closest("[data-testid=chat-search]")?.contains(at);
    close();
    if (!inside) return;
    const back = before.current?.isConnected ? before.current : returnFocus?.current;
    before.current = null;
    back?.focus({ preventScroll: true });
  }, [close, returnFocus]);

  // Another chat: closed, the focus left alone (the chat that opens decides).
  useEffect(() => close, [chat, close]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key.toLowerCase() !== "f" || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      e.preventDefault();
      show();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, show]);

  useEffect(() => {
    if (!query.trim()) { setTerm(""); return; }
    const timer = setTimeout(() => setTerm(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // Folded once while the search is open, not on each key; a closed search costs nothing. `t`: a voice message, a video
  // or a picture is found by its kind in the profile's language too.
  const items = useMemo(() => (open ? searchable(messages, t) : []), [open, messages, t]);
  const results = useMemo(() => searchMessages(items, term), [items, term]);
  const found = useMemo(() => new Set(results), [results]);
  const latest = useRef(results);
  latest.current = results;

  // New words: the newest match. A message coming in meanwhile moves nothing.
  useEffect(() => {
    const first = latest.current[0] ?? null;
    setCurrent(first);
    if (!first) return;
    // Its own task: drawing every row (a long chat still drawing its older ones) cannot happen inside an effect.
    const timer = setTimeout(() => jump(first), 0);
    return () => clearTimeout(timer);
  }, [term]);

  const index = current ? results.indexOf(current) : -1;
  const step = useCallback((by: 1 | -1) => {
    // Enter before the pause is over: these words now, on their newest match.
    if (query.trim() && query !== term) { setTerm(query); return; }
    const list = latest.current;
    if (!list.length) return;
    const at = current ? list.indexOf(current) : -1;
    const next = list[at < 0 ? 0 : (at + by + list.length) % list.length];
    setCurrent(next);
    jump(next);
  }, [current, query, term]);
  const older = useCallback(() => step(1), [step]);
  const newer = useCallback(() => step(-1), [step]);

  /** The words to mark in a message: the search's, when that message is one of its matches. */
  const highlight = useCallback((id: string) => (found.has(id) ? term : undefined), [found, term]);

  return { open, show, close, dismiss, query, setQuery, term, results, index, current, older, newer, highlight, inputRef };
}

export type ChatSearch = ReturnType<typeof useChatSearch>;

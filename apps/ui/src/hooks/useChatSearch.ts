import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { searchable, searchMessages } from "../lib/chatSearch";
import { jumpToMessage } from "../lib/replies";
import type { Translate } from "../locales/translate";
import type { ChatMessage } from "../lib/types";
import { revealMessage } from "./useRowWindow";
import { useShownTranslations } from "./useTranslation";
import { useIsLocked } from "../contexts/LockScreenContext";
import { modalOpen } from "./useAppCommands";

/** How long typing rests before the chat is searched: a long chat is searched once per pause, not once per key. */
export const SEARCH_DEBOUNCE_MS = 150;

/** Scrolls to a message and marks it, as a quote's tap does, bringing the rows around it in first when it is not in the page. */
function jump(id: string) {
  if (!jumpToMessage(id) && revealMessage(id)) jumpToMessage(id);
}

/**
 * Where a match no longer among `now` stood in it: the place of the first one older than it (`before`, newest first, as
 * the matches were while it was among them) that still is, or the end. Matches that came since are newer, before it.
 * -1 when it was never among `before`.
 */
function placeOf(id: string, before: readonly string[], now: readonly string[]): number {
  const was = before.indexOf(id);
  if (was < 0) return -1;
  for (let i = was + 1; i < before.length; i++) {
    const at = now.indexOf(before[i]);
    if (at >= 0) return at;
  }
  return now.length;
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
  // Behind the lock screen the chat stays mounted: Ctrl/Cmd+F typed there is the lock screen's, not the chat's.
  const locked = useIsLocked();

  const close = useCallback(() => { setOpen(false); setQuery(""); setTerm(""); setCurrent(null); }, []);
  const show = useCallback(() => {
    const at = document.activeElement;
    const bar = inputRef.current?.closest("[data-testid=chat-search]");
    if (!bar?.contains(at)) before.current = at instanceof HTMLElement && at !== document.body && !at.closest("[data-menu]") ? at : null;
    // Already open: back to its field, the words in it chosen, so typing replaces them.
    const field = inputRef.current;
    if (field) { field.focus(); field.select(); return; }
    setOpen(true);
    // The new field takes the focus as it mounts (autoFocus); the frame after only makes sure. Choosing its words there
    // chose the keys typed meanwhile (a late frame on a busy phone), and the next key replaced them.
    requestAnimationFrame(() => { if (document.activeElement !== inputRef.current) inputRef.current?.focus(); });
  }, []);

  /**
   * Closed by the person (Escape, ✕): the focus goes back where it was, so the keys go on from there. Before, it fell to
   * the page. Focus that went somewhere else meanwhile (a click in the chat) stays there.
   */
  const dismiss = () => {
    const at = document.activeElement;
    const inside = !at || at === document.body || !!inputRef.current?.closest("[data-testid=chat-search]")?.contains(at);
    close();
    if (!inside) return;
    const back = before.current?.isConnected ? before.current : returnFocus?.current;
    before.current = null;
    back?.focus({ preventScroll: true });
  };

  // Another chat: closed, the focus left alone (the chat that opens decides).
  useEffect(() => close, [chat, close]);

  useEffect(() => {
    if (!active || locked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key.toLowerCase() !== "f" || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      // A dialog over the chat keeps its keys and its focus, as the app's other shortcuts leave it.
      if (modalOpen()) return;
      e.preventDefault();
      show();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, locked, show]);

  useEffect(() => {
    if (!query.trim()) { setTerm(""); return; }
    const timer = setTimeout(() => setTerm(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // Folded once while the search is open, not on each key; a closed search costs nothing. `t`: a voice message, a video
  // or a picture is found by its kind in the profile's language too. `translated`: a received text shown translated is
  // found by the words shown (folded again when a translation comes or Show original is pressed).
  const translated = useShownTranslations(chat, open);
  const items = useMemo(() => (open ? searchable(messages, t, translated) : []), [open, messages, t, translated]);
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
  /** The matches as they were while the one being read was among them: where it stood, once it is gone. */
  const held = useRef(results);
  if (index >= 0) held.current = results;
  const step = useCallback((by: 1 | -1) => {
    // Enter before the pause is over: these words now, on their newest match.
    if (query.trim() && query !== term) { setTerm(query); return; }
    const list = latest.current;
    if (!list.length) return;
    const at = current ? list.indexOf(current) : -1;
    // The one being read went (deleted here or for everyone, edited so it no longer matches): on from where it stood,
    // to the one older or newer than it. Before, the search began again at the newest.
    const gone = at < 0 && current ? placeOf(current, held.current, list) : -1;
    const next = gone >= 0 ? list[(by === 1 ? gone : gone - 1 + list.length) % list.length]
      : list[at < 0 ? 0 : (at + by + list.length) % list.length];
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

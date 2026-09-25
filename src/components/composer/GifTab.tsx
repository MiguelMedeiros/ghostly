import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../contexts/I18nContext";
import { busyUntil, earlierGifs, keptGifs, searchGifs, type GifAnswer, type PickerGif } from "../../lib/gifSearch";
import { GIF_CATEGORY_ICONS } from "./icons";
import { CategoryBar, PanelSearch } from "./PanelParts";

/** A search's answer, kept with the search it answers: the grid shows it only while that is still the search. */
type Results = GifAnswer & { query: string };

/** Typing waits for a pause before it asks: each search counts against the Archive's limit. */
const TYPING_PAUSE_MS = 600;
/** A category waits a moment too, so icons clicked on the way to another one ask nothing. */
const CATEGORY_PAUSE_MS = 250;

/** GifCities has no "trending": the icons over the grid are searches it answers well, ghosts first. */
const GIF_CATEGORIES: { id: string; query: string }[] = [
  { id: "ghosts", query: "ghost" },
  { id: "happy", query: "happy" },
  { id: "sad", query: "sad" },
  { id: "love", query: "love" },
  { id: "yes", query: "thumbs up" },
  { id: "party", query: "party" },
  { id: "animals", query: "cat" },
  { id: "retro", query: "computer" },
];

/** How long until search may be asked again, as m:ss. */
const formatWait = (ms: number) => {
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/**
 * The panel's GIFs, from GifCities (the Internet Archive's GeoCities GIFs): category icons that are ready-made
 * searches, a search field, and the results in columns of their own heights. A GIF is sent as soon as it is chosen.
 *
 * The grid only ever shows the current search's answer. GifCities takes seconds, so while a category's answer is on
 * its way the grid is a spinner, never the last category's tiles (which looked like the click did nothing). Answers
 * are kept for the app session (`lib/gifSearch.ts`), so a category seen once is back at once, in any panel.
 *
 * When the Archive says to wait (its rate limit), the panel says search is busy and counts down; Try again stays off
 * until the wait is over, and nothing asks again by itself. Meanwhile it shows the GIFs it has from earlier, or offers
 * the emoji instead.
 */
export function GifTab({ onSelect, onEmojiTab, autoFocus }: { onSelect: (url: string) => void; onEmojiTab?: () => void; autoFocus?: boolean }) {
  const { t } = useI18n();
  const [category, setCategory] = useState(GIF_CATEGORIES[0].id);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Results | null>(null);
  /** Bumped by "Try again": the search runs again, and the tiles are drawn anew. */
  const [attempt, setAttempt] = useState(0);
  // The Wayback Machine lost some of these files; drop the tiles that do not load.
  const [broken, setBroken] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(Date.now);
  const inputRef = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => { if (autoFocus) inputRef.current?.focus({ preventScroll: true }); }, [autoFocus]);

  const typed = query.trim();
  const search = typed || GIF_CATEGORIES.find((c) => c.id === category)!.query;
  useEffect(() => {
    const show = (answer: Results) => {
      setResults(answer);
      setBroken(new Set());
      setNow(Date.now());
      if (answer.kind === "ok" && scroller.current) scroller.current.scrollTop = 0;
    };
    const gifs = keptGifs(search);
    if (gifs) { show({ query: search, kind: "ok", gifs }); return; }
    if (busyUntil()) { show({ query: search, kind: "limited" }); return; }
    let live = true;
    const timer = setTimeout(() => {
      void searchGifs(search).then((answer) => { if (live) show({ query: search, ...answer }); });
    }, typed ? TYPING_PAUSE_MS : CATEGORY_PAUSE_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [search, typed, attempt]);

  const current = results?.query === search ? results : null;
  // The wait, counted down each second while it is on.
  const until = current?.kind === "limited" ? busyUntil() : null;
  useEffect(() => {
    if (!until) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [until]);
  const wait = until && until > now ? until - now : 0;

  const loading = !current;
  // A spinner while it asks again; an answer this session has is back at once.
  const retry = () => { setResults(null); setBroken(new Set()); setAttempt((n) => n + 1); };
  const tiles = (gifs: PickerGif[], query: string, earlier = false) => (
    <div className="gif-masonry" data-testid="gif-grid" data-query={query} data-earlier={earlier || undefined}>
      {gifs.filter((gif) => !broken.has(gif.id)).map((gif) => (
        <button key={`${attempt}:${gif.id}`} type="button" data-testid="gif-result" onClick={() => onSelect(gif.url)} title={gif.title} className="gif-tile">
          <img src={gif.previewUrl} alt={gif.title} loading="lazy" onError={() => setBroken((prev) => new Set(prev).add(gif.id))} />
        </button>
      ))}
    </div>
  );
  const trouble = (message: string) => (
    <div className="expression-trouble" data-testid="gif-trouble" role="status">
      <p>{message}</p>
      <button type="button" className="expression-retry" data-testid="gif-retry" onClick={retry}>{t("composer.retry")}</button>
    </div>
  );
  const busy = () => {
    const earlier = earlierGifs(search);
    return <>
      <div className={earlier ? "expression-trouble gif-busy-bar" : "expression-trouble"} data-testid="gif-busy">
        <p role="status">{t("composer.gifsBusy")}</p>
        <p id="gif-busy-wait" className="gif-busy-wait" data-testid="gif-busy-wait">{wait ? t("composer.gifsBusyWait", { time: formatWait(wait) }) : t("composer.gifsBusyOver")}</p>
        <div className="gif-busy-actions">
          <button type="button" className="expression-retry" data-testid="gif-retry" onClick={retry} disabled={!!wait} aria-describedby="gif-busy-wait">{t("composer.retry")}</button>
          {!earlier && onEmojiTab && <button type="button" className="expression-retry" data-testid="gif-emoji-instead" onClick={onEmojiTab}>{t("composer.gifsEmojiInstead")}</button>}
        </div>
      </div>
      {earlier && <>
        <p className="gif-earlier" data-testid="gif-earlier">{t("composer.gifsEarlier")}</p>
        {tiles(earlier.gifs, earlier.query, true)}
      </>}
    </>;
  };
  const shown = current?.kind === "ok" ? current.gifs.filter((gif) => !broken.has(gif.id)) : [];
  return (
    <div className="expression-tab" data-testid="gif-tab">
      <CategoryBar label={t("composer.gifCategories")} testIdPrefix="gif-category" active={typed ? null : category}
        onChoose={(id) => { setCategory(id); setQuery(""); }}
        items={GIF_CATEGORIES.map((c) => ({ id: c.id, label: t(`composer.gifCategory.${c.id}` as Parameters<typeof t>[0]), icon: GIF_CATEGORY_ICONS[c.id] }))} />
      <PanelSearch value={query} onChange={setQuery} placeholder={t("composer.searchGifs")} inputRef={inputRef} />
      <div ref={scroller} className="expression-scroll" aria-busy={loading}>
        {loading ? (
          <div className="expression-empty" data-testid="gif-loading"><div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" /></div>
        ) : current.kind === "limited" ? (
          busy()
        ) : current.kind === "unavailable" ? (
          trouble(t("composer.gifsUnavailable"))
        ) : !current.gifs.length ? (
          <p className="expression-empty" data-testid="gif-empty">{t("composer.noGifs")}</p>
        ) : !shown.length ? (
          trouble(t("composer.gifsNotLoading"))
        ) : (
          tiles(current.gifs, search)
        )}
        <p className="gif-source">{t("composer.gifSource")}</p>
      </div>
    </div>
  );
}

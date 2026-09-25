import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../contexts/I18nContext";
import { GIF_CATEGORY_ICONS } from "./icons";
import { CategoryBar, PanelSearch } from "./PanelParts";

interface GifCitiesGif {
  gif: string;
  url_text: string;
  checksum: string;
}

/** What the grid shows, whichever source it came from. */
interface PickerGif {
  id: string;
  title: string;
  previewUrl: string;
  url: string;
}

/** A search's answer, kept with the search it answers: the grid shows it only while that is still the search. */
interface Results {
  query: string;
  gifs: PickerGif[];
}

const GIFCITIES_SEARCH_URL = "https://gifcities.archive.org/api/v1/gifsearch";
const WAYBACK_URL = "https://web.archive.org/web/";
const RESULTS_LIMIT = 20;
/** GifCities answers in about 3 s; past this the panel says so rather than spin on. */
const REQUEST_TIMEOUT_MS = 20_000;

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

async function searchGifCities(query: string, signal: AbortSignal): Promise<PickerGif[]> {
  const q = encodeURIComponent(query);
  const res = await fetch(`${GIFCITIES_SEARCH_URL}?q=${q}&limit=${RESULTS_LIMIT}`, {signal});
  if (!res.ok) throw new Error("GIF search unavailable");
  const json = (await res.json()) as GifCitiesGif[];
  return json
    .filter((gif) => /\.gif$/i.test(gif.gif))
    .map((gif) => ({
      id: gif.checksum,
      title: gif.url_text,
      previewUrl: `${WAYBACK_URL}${gif.gif}`,
      url: `${WAYBACK_URL}${gif.gif}`,
    }));
}

/**
 * The panel's GIFs, from GifCities (the Internet Archive's GeoCities GIFs): category icons that are ready-made
 * searches, a search field, and the results in columns of their own heights. A GIF is sent as soon as it is chosen.
 *
 * The grid only ever shows the current search's answer. GifCities takes seconds, so while a category's answer is on
 * its way the grid is a spinner, never the last category's tiles (which looked like the click did nothing). Answers
 * are kept for the panel's life, so a category seen once is back at once.
 */
export function GifTab({ onSelect, autoFocus }: { onSelect: (url: string) => void; autoFocus?: boolean }) {
  const { t } = useI18n();
  const [category, setCategory] = useState(GIF_CATEGORIES[0].id);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Results | null>(null);
  /** The search GifCities did not answer, if it is the current one. */
  const [failed, setFailed] = useState<string | null>(null);
  /** Bumped by "Try again": the search runs again, and the tiles are drawn anew. */
  const [attempt, setAttempt] = useState(0);
  // The Wayback Machine lost some of these files; drop the tiles that do not load.
  const [broken, setBroken] = useState<Set<string>>(new Set());
  const answers = useRef(new Map<string, PickerGif[]>());
  const inputRef = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => { if (autoFocus) inputRef.current?.focus({ preventScroll: true }); }, [autoFocus]);

  const typed = query.trim();
  const search = typed || GIF_CATEGORIES.find((c) => c.id === category)!.query;
  useEffect(() => {
    const show = (gifs: PickerGif[]) => {
      setResults({ query: search, gifs });
      setBroken(new Set());
      setFailed(null);
      if (scroller.current) scroller.current.scrollTop = 0;
    };
    const known = answers.current.get(search);
    if (known) { show(known); return; }
    const controller = new AbortController();
    let timedOut = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(async () => {
      deadline = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
      try {
        const gifs = await searchGifCities(search, controller.signal);
        if (controller.signal.aborted) return;
        answers.current.set(search, gifs);
        show(gifs);
      } catch {
        if (timedOut || !controller.signal.aborted) setFailed(search);
      } finally {
        clearTimeout(deadline);
      }
    }, typed ? 400 : 0);
    return () => { clearTimeout(timer); clearTimeout(deadline); controller.abort(); };
  }, [search, typed, attempt]);

  const current = results?.query === search ? results : null;
  const shown = current ? current.gifs.filter((gif) => !broken.has(gif.id)) : [];
  const loading = !current && failed !== search;
  const retry = () => { setFailed(null); setBroken(new Set()); setAttempt((n) => n + 1); };
  const trouble = (message: string) => (
    <div className="expression-trouble" data-testid="gif-trouble" role="status">
      <p>{message}</p>
      <button type="button" className="expression-retry" data-testid="gif-retry" onClick={retry}>{t("composer.retry")}</button>
    </div>
  );
  return (
    <div className="expression-tab" data-testid="gif-tab">
      <CategoryBar label={t("composer.gifCategories")} testIdPrefix="gif-category" active={typed ? null : category}
        onChoose={(id) => { setCategory(id); setQuery(""); }}
        items={GIF_CATEGORIES.map((c) => ({ id: c.id, label: t(`composer.gifCategory.${c.id}` as Parameters<typeof t>[0]), icon: GIF_CATEGORY_ICONS[c.id] }))} />
      <PanelSearch value={query} onChange={setQuery} placeholder={t("composer.searchGifs")} inputRef={inputRef} />
      <div ref={scroller} className="expression-scroll" aria-busy={loading}>
        {loading ? (
          <div className="expression-empty" data-testid="gif-loading"><div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" /></div>
        ) : !current ? (
          trouble(t("composer.gifsUnavailable"))
        ) : !current.gifs.length ? (
          <p className="expression-empty" data-testid="gif-empty">{t("composer.noGifs")}</p>
        ) : !shown.length ? (
          trouble(t("composer.gifsNotLoading"))
        ) : (
          <div className="gif-masonry" data-testid="gif-grid" data-query={search}>
            {shown.map((gif) => (
              <button key={`${attempt}:${gif.id}`} type="button" data-testid="gif-result" onClick={() => onSelect(gif.url)} title={gif.title} className="gif-tile">
                <img src={gif.previewUrl} alt={gif.title} loading="lazy" onError={() => setBroken((prev) => new Set(prev).add(gif.id))} />
              </button>
            ))}
          </div>
        )}
        <p className="gif-source">{t("composer.gifSource")}</p>
      </div>
    </div>
  );
}

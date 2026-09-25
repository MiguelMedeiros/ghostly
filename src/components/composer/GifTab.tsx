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

const GIFCITIES_SEARCH_URL = "https://gifcities.archive.org/api/v1/gifsearch";
const WAYBACK_URL = "https://web.archive.org/web/";
const RESULTS_LIMIT = 20;

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
 */
export function GifTab({ onSelect, autoFocus }: { onSelect: (url: string) => void; autoFocus?: boolean }) {
  const { t } = useI18n();
  const [category, setCategory] = useState(GIF_CATEGORIES[0].id);
  const [query, setQuery] = useState("");
  const [gifs, setGifs] = useState<PickerGif[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  // The Wayback Machine lost some of these files; drop the tiles that do not load.
  const [broken, setBroken] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => { if (autoFocus) inputRef.current?.focus({ preventScroll: true }); }, [autoFocus]);

  const typed = query.trim();
  const search = typed || GIF_CATEGORIES.find((c) => c.id === category)!.query;
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      setFailed(false);
      try {
        const results = await searchGifCities(search, controller.signal);
        if (!controller.signal.aborted) { setGifs(results); setBroken(new Set()); if (scroller.current) scroller.current.scrollTop = 0; }
      } catch {
        if (!controller.signal.aborted) { setGifs([]); setFailed(true); }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, typed ? 400 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [search, typed]);

  const shown = gifs.filter((gif) => !broken.has(gif.id));
  return (
    <div className="expression-tab" data-testid="gif-tab">
      <CategoryBar label={t("composer.gifCategories")} testIdPrefix="gif-category" active={typed ? null : category}
        onChoose={(id) => { setCategory(id); setQuery(""); }}
        items={GIF_CATEGORIES.map((c) => ({ id: c.id, label: t(`composer.gifCategory.${c.id}` as Parameters<typeof t>[0]), icon: GIF_CATEGORY_ICONS[c.id] }))} />
      <PanelSearch value={query} onChange={setQuery} placeholder={t("composer.searchGifs")} inputRef={inputRef} />
      <div ref={scroller} className="expression-scroll" aria-busy={loading}>
        {loading && !shown.length ? (
          <div className="expression-empty"><div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" /></div>
        ) : !shown.length ? (
          <p className="expression-empty" data-testid="gif-empty">{failed ? t("composer.gifsUnavailable") : t("composer.noGifs")}</p>
        ) : (
          <div className="gif-masonry" data-testid="gif-grid">
            {shown.map((gif) => (
              <button key={gif.id} type="button" data-testid="gif-result" onClick={() => onSelect(gif.url)} title={gif.title} className="gif-tile">
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

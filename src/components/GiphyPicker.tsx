import { useState, useEffect, useRef, useCallback } from "react";
import { useSettings } from "../contexts/SettingsContext";

interface GiphyPickerProps {
  onSelect: (url: string) => void;
  onClose: () => void;
}

interface GiphyGif {
  id: string;
  title: string;
  images: {
    fixed_width_small: { url: string; width: string; height: string };
    fixed_width: { url: string; width: string; height: string };
    original: { url: string };
  };
}

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

/**
 * `giphy` needs an API key. `retro` is GifCities, the Internet Archive's index
 * of GeoCities GIFs: no key, no account, and rather on theme for a ghost.
 */
type Source = "giphy" | "retro";

/** Set at build time for releases; the user's own key from Settings takes precedence. */
const BUILD_API_KEY: string = import.meta.env.VITE_GIPHY_API_KEY ?? "";
const GIPHY_SEARCH_URL = "https://api.giphy.com/v1/gifs/search";
const GIPHY_TRENDING_URL = "https://api.giphy.com/v1/gifs/trending";
const GIFCITIES_SEARCH_URL = "https://gifcities.archive.org/api/v1/gifsearch";
const WAYBACK_URL = "https://web.archive.org/web/";
/** GifCities has no "trending"; this is what an empty search shows. */
const RETRO_DEFAULT_QUERY = "ghost";
const RESULTS_LIMIT = 20;

async function searchGiphy(query: string, apiKey: string): Promise<PickerGif[] | "rejected"> {
  const url = query
    ? `${GIPHY_SEARCH_URL}?api_key=${apiKey}&q=${encodeURIComponent(query)}&limit=${RESULTS_LIMIT}&rating=g`
    : `${GIPHY_TRENDING_URL}?api_key=${apiKey}&limit=${RESULTS_LIMIT}&rating=g`;
  const res = await fetch(url);
  const json = await res.json();
  // Giphy answers 401/403 ("BANNED") for retired keys, such as the one old builds shipped with.
  const status = json.meta?.status ?? res.status;
  if (status === 401 || status === 403) return "rejected";
  return ((json.data ?? []) as GiphyGif[]).map((gif) => ({
    id: gif.id,
    title: gif.title,
    previewUrl: gif.images.fixed_width_small.url,
    url: gif.images.fixed_width.url,
  }));
}

async function searchGifCities(query: string): Promise<PickerGif[]> {
  const q = encodeURIComponent(query || RETRO_DEFAULT_QUERY);
  const res = await fetch(`${GIFCITIES_SEARCH_URL}?q=${q}&limit=${RESULTS_LIMIT}`);
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

export function GiphyPicker({ onSelect, onClose }: GiphyPickerProps) {
  const [query, setQuery] = useState("");
  const [gifs, setGifs] = useState<PickerGif[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyRejected, setKeyRejected] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const { settings, updateGiphyApiKey } = useSettings();
  const apiKey = settings.giphyApiKey || BUILD_API_KEY;
  // Without a usable Giphy key the picker still has GIFs to offer.
  const [source, setSource] = useState<Source>(apiKey ? "giphy" : "retro");
  const queryRef = useRef("");
  // The Wayback Machine lost some of these files; drop the tiles that do not load.
  const [broken, setBroken] = useState<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [onClose]);

  const fetchGifs = useCallback(
    async (searchQuery: string) => {
      const q = searchQuery.trim();
      setLoading(true);
      try {
        if (source === "retro") {
          setGifs(await searchGifCities(q));
          return;
        }
        const result = apiKey ? await searchGiphy(q, apiKey) : "rejected";
        setKeyRejected(result === "rejected");
        setGifs(result === "rejected" ? [] : result);
      } catch (err) {
        console.error("[gifs] fetch error:", err);
        setGifs([]);
      } finally {
        setLoading(false);
      }
    },
    [apiKey, source],
  );

  useEffect(() => {
    fetchGifs(queryRef.current);
  }, [fetchGifs]);

  const handleSearchChange = (value: string) => {
    setQuery(value);
    queryRef.current = value;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchGifs(value), 400);
  };

  const handleSelect = (gif: PickerGif) => onSelect(gif.url);

  return (
    <>
    <div className="sheet-backdrop" />
    <div
      ref={containerRef}
      className="sheet absolute bottom-full left-0 mb-2 z-50 animate-fade-in w-[340px] bg-panel-header border border-border rounded-xl shadow-2xl overflow-hidden"
    >
      <div className="p-2.5 border-b border-border">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder={source === "retro" ? "Search retro GIFs..." : "Search GIFs..."}
            className="flex-1 bg-input-bg border-none rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none"
            onKeyDown={(e) => e.key === "Escape" && onClose()}
          />
          <button
            onClick={onClose}
            className="p-1.5 text-text-muted hover:text-text-primary transition-colors cursor-pointer bg-transparent border-none"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex gap-1 mt-2">
          {(["giphy", "retro"] as const).map((option) => (
            <button
              key={option}
              onClick={() => setSource(option)}
              className={`flex-1 px-2 py-1 rounded-md text-[11px] font-bold uppercase tracking-wider transition-colors cursor-pointer border-none ${
                source === option
                  ? "bg-accent text-[#111b21]"
                  : "bg-surface-hover text-text-muted hover:text-text-primary"
              }`}
            >
              {option === "giphy" ? "Giphy" : "Retro"}
            </button>
          ))}
        </div>
      </div>

      <div className="h-[280px] max-md:h-[46dvh] overflow-y-auto p-2">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          </div>
        ) : source === "giphy" && keyRejected ? (
          <form
            className="flex flex-col justify-center h-full gap-2 px-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (keyDraft.trim()) updateGiphyApiKey(keyDraft);
            }}
          >
            <p className="text-text-primary text-sm font-medium">Giphy needs an API key</p>
            <p className="text-text-muted text-xs leading-snug">
              Create a free one at developers.giphy.com (an "API" key, not "SDK") and paste it here. It is stored on
              this device only, and you can change it in Settings. Retro GIFs work without one.
            </p>
            <input
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              placeholder="Giphy API key"
              className="bg-input-bg border-none rounded-lg px-3 py-2 text-sm font-mono text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <button
              disabled={!keyDraft.trim()}
              className="px-3 py-2 bg-accent text-[#111b21] rounded-lg text-xs font-bold hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Save key
            </button>
            {settings.giphyApiKey && <p className="text-danger text-xs">Giphy rejected this key.</p>}
          </form>
        ) : gifs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-text-muted text-sm">
            No GIFs found
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            {gifs.filter((gif) => !broken.has(gif.id)).map((gif) => (
              <button
                key={gif.id}
                onClick={() => handleSelect(gif)}
                className="relative overflow-hidden rounded-lg cursor-pointer bg-surface-hover border-none p-0 hover:ring-2 hover:ring-accent transition-all group"
                title={gif.title}
              >
                <img
                  src={gif.previewUrl}
                  alt={gif.title}
                  className={source === "retro" ? "w-full h-24 object-contain block" : "w-full h-auto block"}
                  style={source === "retro" ? { imageRendering: "pixelated" } : undefined}
                  loading="lazy"
                  onError={() => setBroken((prev) => new Set(prev).add(gif.id))}
                />
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="px-2.5 py-1.5 border-t border-border flex items-center justify-end">
        <span className="text-text-muted text-[10px] font-bold tracking-wider">
          {source === "retro" ? "GIFCITIES · INTERNET ARCHIVE" : "POWERED BY GIPHY"}
        </span>
      </div>
    </div>
    </>
  );
}

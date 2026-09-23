import { useOutsideDismiss } from "../hooks/useDismiss";
import { useState, useEffect, useRef } from "react";

interface GifPickerProps {
  onSelect: (url: string) => void;
  onClose: () => void;
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

const GIFCITIES_SEARCH_URL = "https://gifcities.archive.org/api/v1/gifsearch";
const WAYBACK_URL = "https://web.archive.org/web/";
/** GifCities has no "trending"; this is what an empty search shows. */
const RETRO_DEFAULT_QUERY = "ghost";
const RESULTS_LIMIT = 20;

async function searchGifCities(query: string, signal: AbortSignal): Promise<PickerGif[]> {
  const q = encodeURIComponent(query || RETRO_DEFAULT_QUERY);
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

export function GifPicker({ onSelect, onClose }: GifPickerProps) {
  const [query, setQuery] = useState("");
  const [gifs, setGifs] = useState<PickerGif[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  // The Wayback Machine lost some of these files; drop the tiles that do not load.
  const [broken, setBroken] = useState<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useOutsideDismiss(containerRef, true, onClose);



  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      setFailed(false);
      try {
        const results = await searchGifCities(query.trim(), controller.signal);
        if (!controller.signal.aborted) { setGifs(results); setBroken(new Set()); }
      } catch {
        if (!controller.signal.aborted) { setGifs([]); setFailed(true); }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, query ? 400 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);

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
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search GIFs..."
            className="flex-1 bg-input-bg border-none rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none"
            onKeyDown={(e) => e.key === "Escape" && onClose()}
          />
          <button
            aria-label="Close GIF picker"
            onClick={onClose}
            className="p-1.5 text-text-muted hover:text-text-primary transition-colors cursor-pointer bg-transparent border-none"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

      </div>

      <div className="h-[280px] max-md:h-[46dvh] overflow-y-auto p-2">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          </div>
        ) : gifs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-text-muted text-sm">
            {failed ? "GIF search is unavailable. Try again." : "No GIFs found"}
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
                  className="w-full h-24 object-contain block"
                  style={{ imageRendering: "pixelated" }}
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
          GIFCITIES · INTERNET ARCHIVE
        </span>
      </div>
    </div>
    </>
  );
}

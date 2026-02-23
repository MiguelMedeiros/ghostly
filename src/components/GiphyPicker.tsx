import { useState, useEffect, useRef, useCallback } from "react";

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

const GIPHY_PUBLIC_KEY = "dc6zaTOxFJmzC";
const GIPHY_API_KEY = import.meta.env.VITE_GIPHY_API_KEY || GIPHY_PUBLIC_KEY;
const GIPHY_SEARCH_URL = "https://api.giphy.com/v1/gifs/search";
const GIPHY_TRENDING_URL = "https://api.giphy.com/v1/gifs/trending";
const RESULTS_LIMIT = 20;

export function GiphyPicker({ onSelect, onClose }: GiphyPickerProps) {
  const [query, setQuery] = useState("");
  const [gifs, setGifs] = useState<GiphyGif[]>([]);
  const [loading, setLoading] = useState(false);
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

  const fetchGifs = useCallback(async (searchQuery: string) => {
    setLoading(true);
    try {
      const url = searchQuery.trim()
        ? `${GIPHY_SEARCH_URL}?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(searchQuery)}&limit=${RESULTS_LIMIT}&rating=g`
        : `${GIPHY_TRENDING_URL}?api_key=${GIPHY_API_KEY}&limit=${RESULTS_LIMIT}&rating=g`;

      const res = await fetch(url);
      const json = await res.json();
      setGifs(json.data ?? []);
    } catch (err) {
      console.error("[giphy] fetch error:", err);
      setGifs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchGifs("");
  }, [fetchGifs]);

  const handleSearchChange = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchGifs(value), 400);
  };

  const handleSelect = (gif: GiphyGif) => {
    const url = gif.images.fixed_width.url;
    onSelect(url);
  };

  return (
    <div
      ref={containerRef}
      className="absolute bottom-full left-0 mb-2 z-50 animate-fade-in w-[340px] bg-panel-header border border-border rounded-xl shadow-2xl overflow-hidden"
    >
      <div className="p-2.5 border-b border-border">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search GIFs..."
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
      </div>

      <div className="h-[280px] overflow-y-auto p-2">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          </div>
        ) : gifs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-text-muted text-sm">
            No GIFs found
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            {gifs.map((gif) => (
              <button
                key={gif.id}
                onClick={() => handleSelect(gif)}
                className="relative overflow-hidden rounded-lg cursor-pointer bg-surface-hover border-none p-0 hover:ring-2 hover:ring-accent transition-all group"
                title={gif.title}
              >
                <img
                  src={gif.images.fixed_width_small.url}
                  alt={gif.title}
                  className="w-full h-auto block"
                  loading="lazy"
                />
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="px-2.5 py-1.5 border-t border-border flex items-center justify-end">
        <img
          src="https://giphy.com/static/img/poweredby_giphy.png"
          alt="Powered by GIPHY"
          className="h-3 opacity-50"
        />
      </div>
    </div>
  );
}

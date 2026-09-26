import { useMemo, useState } from "react";
import type { LinkPreview } from "@ghostly/core";
import { videoSite } from "../lib/parse/linkPreview";
import { formatCoordinates, locationIn, mapTiles, mapsUrl, openStreetMapUrl, type Place } from "../lib/parse/location";
import { externalLinkProps, mapsPlatform } from "../lib/externalLink";

const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };

function PlayIcon() {
  return (
    <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center">
      <span className="w-12 h-12 rounded-full bg-[rgba(11,20,26,0.6)] flex items-center justify-center">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z" /></svg>
      </span>
    </span>
  );
}

/**
 * A link preview, drawn from what the sender's app sent with the message (WISP 401 § Link previews): nothing here
 * contacts the site. The thumbnail is the sender's own redrawn JPEG. YouTube and Vimeo get a video card; tapping
 * opens the link outside the app, and nothing is ever embedded.
 */
export function LinkPreviewCard({ preview }: { preview: LinkPreview }) {
  const video = videoSite(preview.u);
  const site = preview.s ?? hostOf(preview.u);
  return (
    <a {...externalLinkProps(preview.u)} data-testid="link-preview-card" data-video={video ?? undefined}
      className="mt-1.5 mb-1 block w-[min(300px,68vw)] rounded-md overflow-hidden bg-text-primary/6 border-s-4 border-link no-underline text-text-primary hover:bg-text-primary/10 transition-colors">
      {preview.i && (
        <span className="relative block bg-text-primary/5">
          <img src={preview.i} alt="" data-testid="link-preview-image" className="block w-full max-h-[170px] object-cover" draggable={false} />
          {video && <PlayIcon />}
        </span>
      )}
      <span className="block px-2.5 py-2">
        <span className="block text-[12px] text-text-secondary truncate" data-testid="link-preview-site">{site}</span>
        {preview.t && <span className="block text-[13.5px] font-semibold leading-snug line-clamp-2" data-testid="link-preview-title">{preview.t}</span>}
        {preview.d && <span className="block text-[12.5px] text-text-secondary leading-snug line-clamp-2 mt-0.5" data-testid="link-preview-description">{preview.d}</span>}
        <span className="block text-[11px] text-link truncate mt-1" data-testid="link-preview-url">{hostOf(preview.u)}</span>
      </span>
    </a>
  );
}

function PinIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 22s7-6.1 7-12a7 7 0 0 0-14 0c0 5.9 7 12 7 12z" />
      <circle cx="12" cy="10" r="2.5" />
    </svg>
  );
}

/** The map, from OpenStreetMap's tile server: 2×2 tiles, moved so the place sits in the middle of the frame. */
function MapTiles({ place }: { place: Place }) {
  const [failed, setFailed] = useState(false);
  const { tiles, point } = useMemo(() => mapTiles(place), [place]);
  const width = 280, height = 150;
  if (failed) return <p className="text-[12px] text-text-secondary mt-1.5" role="status">The map could not load. Open it in maps instead.</p>;
  return (
    <div className="relative mt-1.5 rounded-md overflow-hidden bg-text-primary/5" style={{ width: `min(${width}px, 66vw)`, height }} data-testid="location-map">
      <div className="absolute" style={{ left: `calc(50% - ${point.x}px)`, top: height / 2 - point.y, width: 512, height: 512 }}>
        {tiles.map(tile => (
          // Tiles need a Referer by OpenStreetMap's usage policy: the app's origin, never the chat.
          <img key={tile.src} src={tile.src} alt="" width={256} height={256} referrerPolicy="origin" draggable={false}
            onError={() => setFailed(true)} className="absolute block max-w-none" style={{ left: tile.dx * 256, top: tile.dy * 256 }} />
        ))}
      </div>
      <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-full text-danger drop-shadow"><PinIcon size={28} /></span>
      <a {...externalLinkProps("https://www.openstreetmap.org/copyright")} className="absolute end-0 bottom-0 px-1 text-[9px] bg-[rgba(255,255,255,0.8)] text-[#333] no-underline">
        © OpenStreetMap
      </a>
    </div>
  );
}

/**
 * A place named by the message's text (a `geo:` URI, a Google, Apple or OpenStreetMap link), read from the text
 * alone. The map is not loaded until asked for: loading it tells OpenStreetMap this device's address.
 */
export function LocationCard({ place }: { place: Place }) {
  const [showMap, setShowMap] = useState(false);
  const open = mapsUrl(place, mapsPlatform());
  return (
    <div data-testid="location-card" className="mt-1.5 mb-1 w-[min(300px,68vw)] rounded-md bg-text-primary/6 border-s-4 border-accent px-2.5 py-2">
      <div className="flex items-start gap-2">
        <span className="text-accent mt-0.5 shrink-0"><PinIcon /></span>
        <span className="min-w-0">
          <span className="block text-[13.5px] font-semibold leading-snug truncate" data-testid="location-name">{place.name ?? "Location"}</span>
          <span className="block text-[12px] text-text-secondary font-mono" data-testid="location-coordinates">{formatCoordinates(place)}</span>
        </span>
      </div>
      {showMap ? <MapTiles place={place} /> : (
        <>
          <button type="button" data-testid="location-show-map" onClick={() => setShowMap(true)}
            className="mt-1.5 text-[12.5px] text-link underline decoration-dotted cursor-pointer">
            Show map
          </button>
          <span className="block text-[11px] text-text-secondary leading-snug">Loads map tiles from OpenStreetMap, which then sees your IP address.</span>
        </>
      )}
      <div className="mt-1.5 flex gap-3 text-[12.5px]">
        <a {...externalLinkProps(open)} data-testid="location-open" className="text-link underline">Open in maps</a>
        {open !== openStreetMapUrl(place) && /^https?:/.test(place.source) && hostOf(place.source) !== hostOf(open) && (
          <a {...externalLinkProps(place.source)} className="text-link underline truncate">{hostOf(place.source)}</a>
        )}
      </div>
    </div>
  );
}

/**
 * What a text message shows under its words: the link preview the sender attached, and a location card for a
 * place its text names. Nothing when there is neither.
 */
export function MessageLinkCards({ text, preview }: { text: string; preview?: LinkPreview }) {
  const place = useMemo(() => locationIn(text), [text]);
  if (!preview && !place) return null;
  return (
    <div data-testid="message-link-cards">
      {preview && <LinkPreviewCard preview={preview} />}
      {place && <LocationCard place={place} />}
    </div>
  );
}

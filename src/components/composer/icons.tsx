import type { ReactNode } from "react";

/** Icons of the composer, its + menu and its emoji/GIF panel: 24-unit line drawings unless they say otherwise. */

const Line = ({ size = 22, width = 1.8, children }: { size?: number; width?: number; children: ReactNode }) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);
const Solid = ({ size = 22, children }: { size?: number; children: ReactNode }) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="currentColor">{children}</svg>
);

export const PlusIcon = () => <Line size={24} width={2}><path d="M12 5v14M5 12h14" /></Line>;

export const SmileIcon = ({ size = 22 }: { size?: number }) => (
  <Line size={size}><circle cx="12" cy="12" r="9.5" /><path d="M8 14.2s1.5 2 4 2 4-2 4-2" /><path d="M9 9.5h.01M15 9.5h.01" strokeWidth="2.6" /></Line>
);

export const GifIcon = ({ size = 22 }: { size?: number }) => (
  <Line size={size}><rect x="2.5" y="4.5" width="19" height="15" rx="3.5" />
    <text x="12" y="15.2" textAnchor="middle" fill="currentColor" stroke="none" fontSize="7.5" fontWeight="700" fontFamily="system-ui, sans-serif">GIF</text></Line>
);

export const SearchIcon = () => <Line size={16} width={2}><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></Line>;

/* The + menu's rows: solid glyphs, coloured by composer.css. */
export const PaymentGlyph = () => <Solid><path d="M13.4 2.3a.6.6 0 0 1 1 .5l-1.3 7.2h6.3a.6.6 0 0 1 .5 1L10.6 21.7a.6.6 0 0 1-1-.5l1.3-7.2H4.6a.6.6 0 0 1-.5-1z" /></Solid>;
export const IdentityGlyph = () => <Solid><path fillRule="evenodd" d="M4.5 4.5h15A2.5 2.5 0 0 1 22 7v10a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 17V7a2.5 2.5 0 0 1 2.5-2.5zM8.5 8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4zm-3.4 8.3h6.8c-.4-1.7-1.8-2.8-3.4-2.8s-3 1.1-3.4 2.8zM14 9.2a.8.8 0 0 0 0 1.6h4.5a.8.8 0 0 0 0-1.6zm0 3.5a.8.8 0 0 0 0 1.6h3.2a.8.8 0 0 0 0-1.6z" /></Solid>;
/* A globe: the web apps this contact and you open on each other's machines. Its meridian and equator are cut out. */
export const ServicesGlyph = () => <Solid><path fillRule="evenodd" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 0a4.8 10 0 1 0 0 20 4.8 10 0 1 0 0-20zm0 1.4a3.2 8.6 0 1 1 0 17.2 3.2 8.6 0 1 1 0-17.2zM2.05 11.2H7.2v1.6H2.05zm6.75 0h6.4v1.6H8.8zm8 0h5.15v1.6H16.8z" /></Solid>;
export const DocumentGlyph = () => <Solid><path d="M6.5 2h7.2c.4 0 .8.2 1.1.4l4.8 4.8c.3.3.4.7.4 1.1v11.2a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2zM13.5 3.8V7c0 .8.7 1.5 1.5 1.5h3.2zM8 12.2a.8.8 0 0 0 0 1.6h8a.8.8 0 0 0 0-1.6zm0 3.5a.8.8 0 0 0 0 1.6h5.5a.8.8 0 0 0 0-1.6z" /></Solid>;
export const MediaGlyph = () => <Solid><path fillRule="evenodd" d="M5 3h14a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zm3.5 3.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM4 17.6c0 .8.6 1.4 1.4 1.4h13.2c.8 0 1.4-.6 1.4-1.4v-2.2l-4.1-4.1a1 1 0 0 0-1.4 0l-4.6 4.6-1.6-1.6a1 1 0 0 0-1.4 0z" /></Solid>;
export const CameraGlyph = () => <Solid><path fillRule="evenodd" d="M9.2 3h5.6c.7 0 1.3.4 1.6 1l.8 1.5H20a2.5 2.5 0 0 1 2.5 2.5v10a2.5 2.5 0 0 1-2.5 2.5H4A2.5 2.5 0 0 1 1.5 18V8A2.5 2.5 0 0 1 4 5.5h2.8L7.6 4c.3-.6.9-1 1.6-1zM12 8.3a4.7 4.7 0 1 0 0 9.4 4.7 4.7 0 0 0 0-9.4zm0 2a2.7 2.7 0 1 1 0 5.4 2.7 2.7 0 0 1 0-5.4z" /></Solid>;

/* Emoji categories, as emoji-mart names them. */
export const EMOJI_CATEGORY_ICONS: Record<string, ReactNode> = {
  recent: <Line size={20}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Line>,
  people: <SmileIcon size={20} />,
  nature: <Line size={20}><circle cx="7" cy="7" r="2" /><circle cx="17" cy="7" r="2" /><path d="M5 13.5a7 6.5 0 0 0 14 0c0-3-3-5.5-7-5.5s-7 2.5-7 5.5z" /><path d="M9.5 13h.01M14.5 13h.01" strokeWidth="2.6" /><path d="M11 16h2" /></Line>,
  foods: <Line size={20}><path d="M5 9h12v4a6 6 0 0 1-6 6h0a6 6 0 0 1-6-6z" /><path d="M17 10h1.5a2.5 2.5 0 0 1 0 5H16.5" /><path d="M8 3.5c0 1.5 1 1.5 1 3M12 3.5c0 1.5 1 1.5 1 3" /></Line>,
  activity: <Line size={20}><circle cx="12" cy="12" r="9" /><path d="M12 3a15 15 0 0 0 0 18M3 12h18M5.6 5.6c3 2.3 9.8 2.3 12.8 0M5.6 18.4c3-2.3 9.8-2.3 12.8 0" /></Line>,
  places: <Line size={20}><path d="M4 16V11l2-5h12l2 5v5z" /><path d="M4 11h16" /><circle cx="7.5" cy="13.5" r=".6" fill="currentColor" /><circle cx="16.5" cy="13.5" r=".6" fill="currentColor" /><path d="M6 16v2.5M18 16v2.5" /></Line>,
  objects: <Line size={20}><path d="M9 18h6M10 21h4" /><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z" /></Line>,
  symbols: <Line size={20}><path d="M12 20s-7.5-4.5-7.5-10A4.3 4.3 0 0 1 12 7.3 4.3 4.3 0 0 1 19.5 10c0 5.5-7.5 10-7.5 10z" /></Line>,
  flags: <Line size={20}><path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5" /></Line>,
};

/* GIF categories: searches GifCities understands. */
export const GIF_CATEGORY_ICONS: Record<string, ReactNode> = {
  ghosts: <Line size={20}><path d="M5 20V11a7 7 0 0 1 14 0v9l-2.3-1.6-2.4 1.6-2.3-1.6-2.3 1.6-2.4-1.6z" /><path d="M9.5 10.5h.01M14.5 10.5h.01" strokeWidth="2.6" /></Line>,
  happy: <SmileIcon size={20} />,
  sad: <Line size={20}><circle cx="12" cy="12" r="9.5" /><path d="M8 16.5s1.5-2 4-2 4 2 4 2" /><path d="M9 9.5h.01M15 9.5h.01" strokeWidth="2.6" /></Line>,
  love: EMOJI_CATEGORY_ICONS.symbols,
  yes: <Line size={20}><path d="M7 10v10H4V10z" /><path d="M7 10l4-7c1.4 0 2.3 1.1 2 2.5L12.5 9H18a2 2 0 0 1 2 2.3l-1.2 6.5A2.7 2.7 0 0 1 16.1 20H7" /></Line>,
  party: <Line size={20}><path d="M4 20 8.5 7.5l8 8z" /><path d="M13 4.5c.5 1-.5 1.5 0 2.5M19.5 11c-1-.5-1.5.5-2.5 0M16 3v1M21 8h-1M17.5 6.5 19 5" /></Line>,
  animals: <Line size={20}><path d="M5 5l2.5 4M19 5l-2.5 4" /><path d="M4.5 13a7.5 6.5 0 0 0 15 0c0-3-3.4-5-7.5-5s-7.5 2-7.5 5z" /><path d="M9.5 12.5h.01M14.5 12.5h.01" strokeWidth="2.6" /><path d="M11 15.5l1 .8 1-.8" /></Line>,
  retro: <Line size={20}><rect x="3" y="4" width="18" height="12" rx="1.5" /><path d="M8 20h8M12 16v4" /><path d="M7 8h4M7 11h7" /></Line>,
};

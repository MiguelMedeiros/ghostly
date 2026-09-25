import data from "@emoji-mart/data";
import { getPrefix } from "./storage";

/**
 * The emoji the composer's panel offers: emoji-mart's data set (the one its picker used), filtered to what this
 * device can draw, searched by name and keywords, with this profile's recent ones and skin tone remembered.
 */

export interface Emoji {
  id: string;
  name: string;
  /** Each skin tone's character; one entry for an emoji without tones. */
  skins: string[];
  /** Name, id, keywords and emoticons, lower case, for search. */
  search: string;
}

export interface EmojiCategory {
  id: string;
  emojis: Emoji[];
}

interface Data {
  categories: { id: string; emojis: string[] }[];
  emojis: Record<string, { id: string; name: string; keywords?: string[]; emoticons?: string[]; skins: { native: string }[]; version: number }>;
}

/** The newest emoji of each Unicode emoji version: a device that draws it draws the rest of that version. */
const VERSIONS: [number, string][] = [
  [15, "🫨"], [14, "🫠"], [13.1, "😶‍🌫️"], [13, "🥸"], [12.1, "🧑‍🦰"], [12, "🥱"], [11, "🥰"], [5, "🤩"], [4, "👱‍♀️"], [3, "🤣"], [2, "👋🏻"], [1, "🙃"],
];

let drawable: ((emoji: string) => boolean) | null | undefined;

/** Whether this device draws `emoji` as one coloured glyph (the check emoji-mart makes, from is-emoji-supported). */
function draws(emoji: string): boolean | undefined {
  if (drawable === undefined) {
    let ctx: CanvasRenderingContext2D | null = null;
    try { ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true }); } catch { /* no canvas */ }
    drawable = ctx && typeof ctx.getImageData === "function" ? (text) => {
      const w = 20, h = 25;
      ctx.canvas.width = w * 2; ctx.canvas.height = h;
      ctx.font = `${Math.floor(h / 2)}px Arial, Sans-Serif`; ctx.textBaseline = "top";
      ctx.clearRect(0, 0, w * 2, h);
      ctx.fillStyle = "#FF0000"; ctx.fillText(text, 0, 22);
      ctx.fillStyle = "#0000FF"; ctx.fillText(text, w, 22);
      const a = ctx.getImageData(0, 0, w, h).data;
      let i = 0;
      for (; i < a.length && !a[i + 3]; i += 4);
      if (i >= a.length) return false;
      // A colour emoji keeps its colours whatever the fill; a glyph drawn in the fill colour is not one.
      const b = ctx.getImageData(w + (i / 4) % w, Math.floor(i / 4 / w), 1, 1).data;
      if (a[i] !== b[0] || a[i + 2] !== b[2]) return false;
      // An unsupported sequence falls apart into several characters.
      return ctx.measureText(text).width < w;
    } : null;
  }
  return drawable ? drawable(emoji) : undefined;
}

let catalog: EmojiCategory[] | null = null;

/** Every category with the emoji this device can draw (all of them where it cannot be checked, as in tests). */
export function emojiCategories(): EmojiCategory[] {
  if (catalog) return catalog;
  const set = data as unknown as Data;
  const latest = VERSIONS.find(([, emoji]) => draws(emoji) !== false)?.[0] ?? Infinity;
  const flags = draws("🇨🇦") !== false;
  catalog = set.categories.map(({ id, emojis }) => ({
    id,
    emojis: emojis.flatMap((key) => {
      const e = set.emojis[key];
      if (!e || e.version > latest) return [];
      // Windows draws country flags as two letters: keep only the flags that are pictures there.
      if (id === "flags" && !flags && /[\u{1F1E6}-\u{1F1FF}]/u.test(e.skins[0].native)) return [];
      return [{ id: e.id, name: e.name, skins: e.skins.map((s) => s.native),
        search: [e.id.replace(/[-_]/g, " "), e.name, ...(e.keywords ?? []), ...(e.emoticons ?? [])].join(",").toLowerCase() }];
    }),
  })).filter((c) => c.emojis.length);
  return catalog;
}

/** The emoji as drawn in the chosen tone, when it has tones. */
export const withSkin = (emoji: Emoji, skin: number) => emoji.skins[skin] ?? emoji.skins[0];

/** Emoji whose name, keywords or emoticons contain every word typed; the earlier the match, the higher. */
export function searchEmoji(query: string, limit = 96): Emoji[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const found: { emoji: Emoji; score: number }[] = [];
  for (const category of emojiCategories()) for (const emoji of category.emojis) {
    let score = 0;
    for (const word of words) {
      const at = emoji.search.indexOf(word);
      if (at < 0) { score = -1; break; }
      score += at;
    }
    if (score >= 0) found.push({ emoji, score });
  }
  return found.sort((a, b) => a.score - b.score).slice(0, limit).map((f) => f.emoji);
}

let byNative: Map<string, Emoji> | null = null;

/** The emoji a character is, in any tone. */
export function emojiOf(native: string): Emoji | undefined {
  if (!byNative) {
    byNative = new Map();
    for (const category of emojiCategories()) for (const emoji of category.emojis) for (const skin of emoji.skins) byNative.set(skin, emoji);
  }
  return byNative.get(native);
}

/** Three rows of eight, as WhatsApp keeps them. */
export const RECENT_MAX = 24;
const recentKey = () => `${getPrefix()}emoji_recent`;
const skinKey = () => `${getPrefix()}emoji_skin`;

/** This profile's recently used emoji, the latest first. */
export function recentEmoji(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(recentKey()) ?? "[]");
    return Array.isArray(stored) ? stored.filter((e): e is string => typeof e === "string" && !!emojiOf(e)).slice(0, RECENT_MAX) : [];
  } catch { return []; }
}

export function rememberEmoji(native: string): string[] {
  const next = [native, ...recentEmoji().filter((e) => e !== native)].slice(0, RECENT_MAX);
  try { localStorage.setItem(recentKey(), JSON.stringify(next)); } catch { /* recent only until the page reloads */ }
  return next;
}

/** The skin tone this profile chose: 0 is the default yellow, 1-5 the Fitzpatrick tones. */
export function skinTone(): number {
  try {
    const tone = Number(localStorage.getItem(skinKey()));
    return Number.isInteger(tone) && tone >= 0 && tone <= 5 ? tone : 0;
  } catch { return 0; }
}

export function setSkinTone(tone: number) {
  try { localStorage.setItem(skinKey(), String(tone)); } catch { /* this session only */ }
}

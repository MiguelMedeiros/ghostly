import { getPrefix } from "./storage";

/**
 * GIF search, from GifCities (the Internet Archive's GeoCities GIFs), shared by every GIF panel of this app session.
 *
 * The Archive limits requests per IP, and says so with a **200** HTML page ("Rate limit reached"), not a 429, and with
 * no CORS header. So a browser page (the web app, the extension, Desktop's WebView) never reads that page: its fetch
 * fails as a network error does, and online that counts as the limit. Where the page can be read, it is read as text
 * and judged here, never parsed with `json()` on trust. Once limited, nothing is asked until a wait is over that
 * doubles with each limit in a row (30 s, 60 s, 120 s, 5 min at most); every panel, and a reload, sees the same wait.
 * Nothing asks again by itself: the person does, once the wait is over.
 *
 * Answers are kept for this session (20 min fresh, the last 24 searches), so a category or a panel opened again asks
 * nothing, and while search is busy an answer however old is still shown, as earlier results. A search already on its
 * way is shared rather than asked twice, and it is never cancelled: the Archive counts a request once it is sent, so
 * its answer is kept for the next time instead.
 */

export interface PickerGif {
  id: string;
  title: string;
  previewUrl: string;
  url: string;
}

/** What GifCities said: GIFs, "wait" (the rate limit), or nothing usable (offline, a timeout, a 5xx). */
export type GifAnswer = { kind: "ok"; gifs: PickerGif[] } | { kind: "limited" } | { kind: "unavailable" };

export const GIFCITIES_SEARCH_URL = "https://gifcities.archive.org/api/v1/gifsearch";
export const WAYBACK_URL = "https://web.archive.org/web/";
/** The Archive limits requests, not rows; the tiles load lazily, so only the ones in view reach the Wayback Machine. */
const RESULTS_LIMIT = 20;
/** GifCities answers in about 3 s; past this the search counts as unavailable. */
const REQUEST_TIMEOUT_MS = 20_000;
export const FIRST_WAIT_MS = 30_000;
export const LONGEST_WAIT_MS = 5 * 60_000;
export const FRESH_MS = 20 * 60_000;
export const KEPT_SEARCHES = 24;
/** The session's waits and answers, so a reload neither asks again nor forgets it was told to wait. */
const STORE_KEY = "ghostly_gif_search";

interface Kept {
  query: string;
  at: number;
  gifs: PickerGif[];
}

interface State {
  /** No request before this (ms since the epoch). */
  until: number;
  /** Limits in a row: each doubles the wait. */
  strikes: number;
  /** Per profile and search, oldest first. */
  kept: Map<string, Kept>;
}

let state: State | null = null;
const onTheirWay = new Map<string, Promise<GifAnswer>>();

/** A profile's searches stay its own: another profile of this app does not see them as earlier results. */
const keyOf = (query: string) => `${getPrefix()}\n${query.trim().toLowerCase()}`;

const isGif = (value: unknown): value is PickerGif => {
  const gif = value as PickerGif;
  return !!gif && typeof gif.id === "string" && typeof gif.title === "string"
    && typeof gif.url === "string" && gif.url.startsWith(WAYBACK_URL) && typeof gif.previewUrl === "string" && gif.previewUrl.startsWith(WAYBACK_URL);
};

function load(): State {
  if (state) return state;
  state = { until: 0, strikes: 0, kept: new Map() };
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? "null") as { until?: unknown; strikes?: unknown; kept?: unknown } | null;
    if (saved) {
      state.until = Number(saved.until) || 0;
      state.strikes = Number(saved.strikes) || 0;
      for (const entry of Array.isArray(saved.kept) ? saved.kept : []) {
        const [key, kept] = entry as [unknown, Kept];
        if (typeof key === "string" && kept && typeof kept.query === "string" && typeof kept.at === "number" && Array.isArray(kept.gifs) && kept.gifs.every(isGif)) {
          state.kept.set(key, kept);
        }
      }
    }
  } catch { /* a fresh session */ }
  return state;
}

function save(): void {
  const { until, strikes, kept } = load();
  try { sessionStorage.setItem(STORE_KEY, JSON.stringify({ until, strikes, kept: [...kept] })); } catch { /* kept in memory only */ }
}

function keep(query: string, gifs: PickerGif[]): void {
  const { kept } = load();
  const key = keyOf(query);
  kept.delete(key);
  kept.set(key, { query, at: Date.now(), gifs });
  while (kept.size > KEPT_SEARCHES) kept.delete(kept.keys().next().value!);
  save();
}

/** This search's answer, if it came recently enough to show as it is. */
export function keptGifs(query: string): PickerGif[] | null {
  const { kept } = load();
  const key = keyOf(query);
  const found = kept.get(key);
  if (!found || Date.now() - found.at >= FRESH_MS) return null;
  // The last used is the last dropped.
  kept.delete(key);
  kept.set(key, found);
  return found.gifs;
}

/** While search is busy: this search's answer however old, else the latest this profile saw with GIFs in it. */
export function earlierGifs(query: string): { query: string; gifs: PickerGif[] } | null {
  const { kept } = load();
  const own = kept.get(keyOf(query));
  if (own?.gifs.length) return own;
  const prefix = keyOf("");
  for (const [key, found] of [...kept].reverse()) if (key.startsWith(prefix) && found.gifs.length) return found;
  return null;
}

/** When GIF search may be asked again, if the Archive said to wait and the wait is not over. */
export function busyUntil(): number | null {
  const { until } = load();
  return until > Date.now() ? until : null;
}

function limited(): void {
  const s = load();
  const now = Date.now();
  // Searches that were already on their way come back limited too: one limit, not one per search.
  if (s.until > now) return;
  // A limit long after the last wait ended starts over at the shortest wait.
  if (now - s.until > LONGEST_WAIT_MS) s.strikes = 0;
  s.strikes += 1;
  s.until = now + Math.min(FIRST_WAIT_MS * 2 ** (s.strikes - 1), LONGEST_WAIT_MS);
  save();
}

function answered(): void {
  const s = load();
  if (!s.strikes && !s.until) return;
  s.strikes = 0;
  s.until = 0;
  save();
}

/** GifCities' rows, as the grid shows them: GIFs only, each once. */
function toPickerGifs(rows: unknown[]): PickerGif[] {
  const seen = new Set<string>();
  const gifs: PickerGif[] = [];
  for (const row of rows) {
    const { gif, checksum, url_text: title } = (row ?? {}) as { gif?: unknown; checksum?: unknown; url_text?: unknown };
    if (typeof gif !== "string" || !/\.gif$/i.test(gif)) continue;
    const id = typeof checksum === "string" && checksum ? checksum : gif;
    if (seen.has(id)) continue;
    seen.add(id);
    gifs.push({ id, title: typeof title === "string" ? title : "", previewUrl: `${WAYBACK_URL}${gif}`, url: `${WAYBACK_URL}${gif}` });
  }
  return gifs;
}

/**
 * What a GifCities response means. A JSON list is an answer, whatever its content type. A 429, or a page that says
 * "rate limit" whatever its status, is the limit; so is any other 200 that is not JSON (the Archive's limit page is a
 * 200 `text/html`). Anything else (5xx, other 4xx, JSON that is not a list) is unavailable.
 */
export async function readGifCities(res: Response): Promise<GifAnswer> {
  if (res.status === 429) return { kind: "limited" };
  let body: string;
  try { body = await res.text(); } catch { return { kind: "unavailable" }; }
  let data: unknown;
  let parsed = true;
  try { data = JSON.parse(body); } catch { parsed = false; }
  if (res.ok && parsed && Array.isArray(data)) return { kind: "ok", gifs: toPickerGifs(data) };
  if (!parsed && /rate limit/i.test(body)) return { kind: "limited" };
  if (!res.ok) return { kind: "unavailable" };
  if (parsed) return { kind: "unavailable" };
  const type = res.headers.get("content-type") ?? "";
  return /json/i.test(type) && !body.trimStart().startsWith("<") ? { kind: "unavailable" } : { kind: "limited" };
}

const offline = () => typeof navigator !== "undefined" && navigator.onLine === false;

async function ask(query: string): Promise<GifAnswer> {
  const controller = new AbortController();
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
  let answer: GifAnswer;
  try {
    const res = await fetch(`${GIFCITIES_SEARCH_URL}?q=${encodeURIComponent(query)}&limit=${RESULTS_LIMIT}`, { signal: controller.signal });
    answer = await readGifCities(res);
  } catch {
    // The limit page carries no CORS header: in a browser page it fails as a network error does, and a page cannot
    // tell the two apart. Offline it is only that; online the limit is the likely reason, and waiting harms neither.
    answer = timedOut || offline() ? { kind: "unavailable" } : { kind: "limited" };
  } finally {
    clearTimeout(deadline);
  }
  if (answer.kind === "ok") {
    answered();
    keep(query, answer.gifs);
  } else if (answer.kind === "limited") {
    limited();
  }
  return answer;
}

/** A search: from this session's answers if fresh, "limited" at once while the wait is on, else from GifCities. */
export function searchGifs(query: string): Promise<GifAnswer> {
  const gifs = keptGifs(query);
  if (gifs) return Promise.resolve({ kind: "ok", gifs });
  if (busyUntil()) return Promise.resolve({ kind: "limited" });
  const key = keyOf(query);
  let pending = onTheirWay.get(key);
  if (!pending) {
    pending = ask(query).finally(() => onTheirWay.delete(key));
    onTheirWay.set(key, pending);
  }
  return pending;
}

/** Forgets the session's waits and answers (tests). */
export function resetGifSearch(): void {
  state = null;
  onTheirWay.clear();
  try { sessionStorage.removeItem(STORE_KEY); } catch { /* nothing kept */ }
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIRST_WAIT_MS, FRESH_MS, KEPT_SEARCHES, LONGEST_WAIT_MS,
  busyUntil, earlierGifs, keptGifs, readGifCities, searchGifs,
} from "../../lib/gifSearch";
import { setStorageProfile } from "../../lib/storage";

// covers: chat.paired.gifs.busy

/** The page the Internet Archive answers with once an IP has asked too much: a 200, in HTML. */
const RATE_LIMIT_PAGE = `<!DOCTYPE html><html><head><title>Rate limit reached</title></head><body><h1>Rate limit reached</h1>
<p>You've reached the limit for the number of requests that can be made in a short period of time. Please wait a moment and try again.</p></body></html>`;

const rows = (q: string, count = 2) => Array.from({ length: count }, (_, i) => ({ gif: `http://geocities.com/${q}/${i}.gif`, url_text: `${q} ${i}`, checksum: `${q}-${i}` }));
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, ...init });
const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
const limitPage = () => html(RATE_LIMIT_PAGE);
const queryOf = (input: unknown) => new URL(String(input)).searchParams.get("q");

/** GifCities, answering each search with what `answer` returns for it. */
function gifCities(answer: (q: string) => Response | Promise<Response> = (q) => json(rows(q))) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => answer(queryOf(input)!));
}

afterEach(() => {
  vi.useRealTimers();
  setStorageProfile("");
});

describe("what a GifCities response means", () => {
  it("a JSON list is an answer: GIFs only, each once, on the Wayback Machine", async () => {
    const answer = await readGifCities(json([
      ...rows("ghost"),
      { gif: "http://geocities.com/ghost/0.gif", url_text: "again", checksum: "ghost-0" },
      { gif: "http://geocities.com/ghost/still.jpg", url_text: "not a gif", checksum: "jpg" },
      { gif: 42 }, null,
    ]));
    expect(answer).toEqual({ kind: "ok", gifs: [
      { id: "ghost-0", title: "ghost 0", previewUrl: "https://web.archive.org/web/http://geocities.com/ghost/0.gif", url: "https://web.archive.org/web/http://geocities.com/ghost/0.gif" },
      { id: "ghost-1", title: "ghost 1", previewUrl: "https://web.archive.org/web/http://geocities.com/ghost/1.gif", url: "https://web.archive.org/web/http://geocities.com/ghost/1.gif" },
    ] });
  });

  it("a JSON list is an answer whatever its content type says", async () => {
    expect(await readGifCities(new Response(JSON.stringify(rows("cat"))))).toMatchObject({ kind: "ok", gifs: [{ id: "cat-0" }, { id: "cat-1" }] });
    expect(await readGifCities(json([]))).toEqual({ kind: "ok", gifs: [] });
  });

  it("the Archive's rate-limit page, a 200 in HTML, is the limit", async () => {
    expect(await readGifCities(limitPage())).toEqual({ kind: "limited" });
  });

  it("a 429 is the limit, whatever its body", async () => {
    expect(await readGifCities(new Response("", { status: 429 }))).toEqual({ kind: "limited" });
    expect(await readGifCities(json({ error: "slow down" }, { status: 429 }))).toEqual({ kind: "limited" });
  });

  it("any other 200 that is not JSON is the limit too: never parsed on trust", async () => {
    expect(await readGifCities(html("<html><body>Please wait</body></html>"))).toEqual({ kind: "limited" });
    expect(await readGifCities(new Response("   <!doctype html><p>busy</p>", { headers: { "content-type": "application/json" } }))).toEqual({ kind: "limited" });
    expect(await readGifCities(new Response("slow down", { headers: { "content-type": "text/plain" } }))).toEqual({ kind: "limited" });
  });

  it("a 5xx is unavailable, unless its page says it is the rate limit", async () => {
    expect(await readGifCities(new Response("Unavailable", { status: 503 }))).toEqual({ kind: "unavailable" });
    expect(await readGifCities(html("<h1>Internal error</h1>", 500))).toEqual({ kind: "unavailable" });
    expect(await readGifCities(html(RATE_LIMIT_PAGE, 503))).toEqual({ kind: "limited" });
  });

  it("JSON that is not a list, or a broken body labelled JSON, is unavailable", async () => {
    expect(await readGifCities(json({ error: "index offline" }))).toEqual({ kind: "unavailable" });
    expect(await readGifCities(new Response("[{\"gif\":", { headers: { "content-type": "application/json" } }))).toEqual({ kind: "unavailable" });
    expect(await readGifCities(new Response("Not found", { status: 404 }))).toEqual({ kind: "unavailable" });
  });

  it("a GIF named after rate limits is still a GIF", async () => {
    const answer = await readGifCities(json([{ gif: "http://geocities.com/rate_limit_reached.gif", url_text: "Rate limit reached", checksum: "rl" }]));
    expect(answer).toMatchObject({ kind: "ok", gifs: [{ id: "rl" }] });
  });

  it("a network error, or no answer in 20 s, is unavailable, and no reason to wait", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await searchGifs("ghost")).toEqual({ kind: "unavailable" });
    expect(busyUntil()).toBeNull();

    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const slow = searchGifs("cat");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await slow).toEqual({ kind: "unavailable" });
    expect(busyUntil()).toBeNull();
  });
});

describe("the wait after a rate limit", () => {
  beforeEach(() => { vi.useFakeTimers({ now: new Date("2026-09-25T14:35:00Z") }); });

  it("asks nothing for 30 s, then 60 s, 120 s, 240 s, and 5 min at most", async () => {
    const fetch = gifCities(limitPage);
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      expect(await searchGifs("ghost")).toEqual({ kind: "limited" });
      const wait = busyUntil()! - Date.now();
      waits.push(wait);
      // Within the wait every search is answered "limited" at once, without a request.
      const asked = fetch.mock.calls.length;
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(await searchGifs("ghost")).toEqual({ kind: "limited" });
      expect(await searchGifs("happy")).toEqual({ kind: "limited" });
      expect(fetch.mock.calls.length).toBe(asked);
      await vi.advanceTimersByTimeAsync(1);
      expect(busyUntil()).toBeNull();
    }
    expect(waits).toEqual([FIRST_WAIT_MS, 60_000, 120_000, 240_000, LONGEST_WAIT_MS, LONGEST_WAIT_MS]);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it("an answer ends the waits: the next limit waits 30 s again", async () => {
    let limited = true;
    gifCities((q) => limited ? limitPage() : json(rows(q)));
    await searchGifs("ghost");
    await vi.advanceTimersByTimeAsync(FIRST_WAIT_MS);
    await searchGifs("ghost");
    expect(busyUntil()! - Date.now()).toBe(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    limited = false;
    expect(await searchGifs("ghost")).toMatchObject({ kind: "ok" });
    limited = true;
    await searchGifs("happy");
    expect(busyUntil()! - Date.now()).toBe(FIRST_WAIT_MS);
  });

  it("a limit long after the last wait starts over at 30 s", async () => {
    gifCities(limitPage);
    await searchGifs("ghost");
    await vi.advanceTimersByTimeAsync(FIRST_WAIT_MS);
    await searchGifs("ghost");
    await vi.advanceTimersByTimeAsync(60_000 + LONGEST_WAIT_MS + 1);
    await searchGifs("ghost");
    expect(busyUntil()! - Date.now()).toBe(FIRST_WAIT_MS);
  });

  it("searches already on their way that come back limited count as one limit", async () => {
    const answers: (() => void)[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise((resolve) => { answers.push(() => resolve(limitPage())); }));
    const three = ["ghost", "happy", "sad"].map((q) => searchGifs(q));
    await vi.waitFor(() => expect(answers).toHaveLength(3));
    for (const answer of answers) answer();
    expect(await Promise.all(three)).toEqual([{ kind: "limited" }, { kind: "limited" }, { kind: "limited" }]);
    expect(busyUntil()! - Date.now()).toBe(FIRST_WAIT_MS);
  });

  it("is remembered across a reload of the app", async () => {
    gifCities(limitPage);
    await searchGifs("ghost");
    const until = busyUntil();
    vi.resetModules();
    const reloaded = await import("../../lib/gifSearch");
    expect(reloaded.busyUntil()).toBe(until);
    expect(await reloaded.searchGifs("cat")).toEqual({ kind: "limited" });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("the answers kept for the session", () => {
  it("a search asked again, in any letter case, is not asked again", async () => {
    const fetch = gifCities();
    const first = await searchGifs("ghost");
    expect(await searchGifs("ghost")).toEqual(first);
    expect(await searchGifs(" Ghost ")).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("the same search twice at once is one request", async () => {
    const fetch = gifCities();
    const [a, b] = await Promise.all([searchGifs("cat"), searchGifs("cat")]);
    expect(a).toEqual(b);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("are fresh for 20 minutes; older ones are asked again", async () => {
    vi.useFakeTimers();
    const fetch = gifCities();
    await searchGifs("ghost");
    await vi.advanceTimersByTimeAsync(FRESH_MS - 1);
    expect(keptGifs("ghost")).not.toBeNull();
    await searchGifs("ghost");
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(FRESH_MS);
    expect(keptGifs("ghost")).toBeNull();
    await searchGifs("ghost");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keep the last 24 searches, the one used last dropped last", async () => {
    const fetch = gifCities();
    for (let i = 0; i < KEPT_SEARCHES; i++) await searchGifs(`q${i}`);
    // Used again: now the most recent.
    expect(keptGifs("q0")).not.toBeNull();
    await searchGifs("one more");
    expect(keptGifs("q0")).not.toBeNull();
    expect(keptGifs("q1")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(KEPT_SEARCHES + 1);
  });

  it("are not errors: unavailable and limited answers are not kept", async () => {
    let answer = () => new Response("Unavailable", { status: 503 });
    const fetch = gifCities(() => answer());
    await searchGifs("ghost");
    answer = () => json(rows("ghost"));
    expect(await searchGifs("ghost")).toMatchObject({ kind: "ok" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("while search is busy: this search's answer however old, else the latest with GIFs", async () => {
    vi.useFakeTimers();
    gifCities((q) => json(q === "nothing" ? [] : rows(q)));
    await searchGifs("ghost");
    await searchGifs("cat");
    await searchGifs("nothing");
    await vi.advanceTimersByTimeAsync(FRESH_MS * 3);
    expect(earlierGifs("ghost")).toMatchObject({ query: "ghost", gifs: [{ id: "ghost-0" }, { id: "ghost-1" }] });
    // Not seen: the latest answer that had GIFs, not the empty one.
    expect(earlierGifs("party")).toMatchObject({ query: "cat" });
  });

  it("are the profile's own", async () => {
    gifCities();
    setStorageProfile("abcdefghij");
    await searchGifs("secret crush");
    expect(earlierGifs("anything")?.query).toBe("secret crush");
    setStorageProfile("");
    expect(keptGifs("secret crush")).toBeNull();
    expect(earlierGifs("anything")).toBeNull();
  });

  it("outlive a reload of the app, in this session's storage", async () => {
    const fetch = gifCities();
    await searchGifs("ghost");
    vi.resetModules();
    const reloaded = await import("../../lib/gifSearch");
    expect(await reloaded.searchGifs("ghost")).toMatchObject({ kind: "ok", gifs: [{ id: "ghost-0" }, { id: "ghost-1" }] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("ignore what in this session's storage is not theirs to show", async () => {
    sessionStorage.setItem("ghostly_gif_search", JSON.stringify({ until: 0, strikes: 0, kept: [
      ["ghostly_\nghost", { query: "ghost", at: Date.now(), gifs: [{ id: "x", title: "x", previewUrl: "https://evil.example/x.gif", url: "https://evil.example/x.gif" }] }],
    ] }));
    vi.resetModules();
    const reloaded = await import("../../lib/gifSearch");
    expect(reloaded.keptGifs("ghost")).toBeNull();
    sessionStorage.setItem("ghostly_gif_search", "{not json");
    vi.resetModules();
    expect((await import("../../lib/gifSearch")).busyUntil()).toBeNull();
  });
});

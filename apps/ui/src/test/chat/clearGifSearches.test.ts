import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { engine } from "@ghostly/browser/platform/engine";
import { clearAllData } from "../../lib/clearData";
import { busyUntil, earlierGifs, keptGifs, searchGifs } from "../../lib/gifSearch";
import { setStorageProfile } from "../../lib/storage";

// covers: app.clear-data, chat.paired.gifs.busy

vi.mock("@ghostly/browser/shared/fileBytes", async (importOriginal) => ({ ...await importOriginal<object>(), removeFileBytes: vi.fn(async () => {}) }));
vi.mock("../../lib/wakePush", async (importOriginal) => ({ ...await importOriginal<object>(), pushPlatform: () => null }));

const rows = (q: string) => [0, 1].map((i) => ({ gif: `http://geocities.com/${q}/${i}.gif`, url_text: `${q} ${i}`, checksum: `${q}-${i}` }));
const RATE_LIMIT_PAGE = "<html><head><title>Rate limit reached</title></head></html>";

const answer = (input: unknown) =>
  new Response(JSON.stringify(rows(new URL(String(input)).searchParams.get("q")!)), { headers: { "content-type": "application/json" } });

/** GifCities: GIFs for each search, or the Archive's limit page once `limited` says so. */
function gifCities(limited = () => false) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => limited()
    ? new Response(RATE_LIMIT_PAGE, { headers: { "content-type": "text/html" } })
    : answer(input));
}

/** The page Clear all data reloads to, in the same tab. */
async function reload() {
  vi.resetModules();
  return import("../../lib/gifSearch");
}

afterEach(() => { vi.restoreAllMocks(); setStorageProfile(""); });

describe("Clear all data forgets the profile's GIF searches (WISP 04)", () => {
  it("neither this page nor the one it reloads to shows them, not even as earlier results while search is busy", async () => {
    vi.spyOn(engine, "call").mockResolvedValue(undefined as never);
    let limited = false;
    const fetch = gifCities(() => limited);
    expect(await searchGifs("throwaway private words")).toMatchObject({ kind: "ok", gifs: [{}, {}] });
    limited = true;
    expect(await searchGifs("cat")).toEqual({ kind: "limited" });
    expect(earlierGifs("cat")).toMatchObject({ query: "throwaway private words" });

    await clearAllData();

    expect(keptGifs("throwaway private words")).toBeNull();
    expect(earlierGifs("cat")).toBeNull();
    expect(sessionStorage.getItem("ghostly_gif_search") ?? "").not.toContain("throwaway");
    const after = await reload();
    expect(after.earlierGifs("cat")).toBeNull();
    expect(after.keptGifs("throwaway private words")).toBeNull();
    // The Archive's wait is this IP's, not the profile's: the page still does not ask while it is on.
    expect(after.busyUntil()).not.toBeNull();
    expect(busyUntil()).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("an answer still on its way when the clear runs is not kept", async () => {
    vi.spyOn(engine, "call").mockResolvedValue(undefined as never);
    let arrive!: () => void;
    const late = new Promise<void>((resolve) => { arrive = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => { await late; return answer(input); });
    const search = searchGifs("on its way");
    await clearAllData();
    arrive();
    await search;
    expect(keptGifs("on its way")).toBeNull();
    expect((await reload()).earlierGifs("on its way")).toBeNull();
  });

  it("another profile's searches stay its own", async () => {
    vi.spyOn(engine, "call").mockResolvedValue(undefined as never);
    gifCities();
    setStorageProfile("otherprofile");
    await searchGifs("theirs");
    setStorageProfile("");
    await searchGifs("mine");
    await clearAllData();
    const after = await reload();
    expect(after.earlierGifs("mine")).toBeNull();
    (await import("../../lib/storage")).setStorageProfile("otherprofile");
    expect(after.earlierGifs("anything")).toMatchObject({ query: "theirs" });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VERSION, assetNames } from "../../../apps/website/lib/release";

/*
 * ghostly.tools asks GitHub for the latest release (apps/website/lib/latestRelease.ts) from pages rendered on each
 * visit (/apps, /privacy, the sitemap). Next's data cache keeps only a 200, so the site remembers every answer itself:
 * a rate limit or a slow GitHub must not send each visit to GitHub, nor make it wait.
 */

const ok = (tag: string) =>
  new Response(JSON.stringify({ tag_name: tag, assets: Object.values(assetNames(tag.slice(1))).map((name) => ({ name })) }), { status: 200 });
const limited = () => new Response('{"message":"API rate limit exceeded"}', { status: 403 });

/** Lets an ask that is already answered finish. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

async function fresh() {
  vi.resetModules();
  return import("../../../apps/website/lib/latestRelease");
}

describe("website latest release", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("asks GitHub once while it rate-limits the site, and again after the retry delay", async () => {
    const { latestRelease, RETRY_AFTER_MS } = await fresh();
    fetchMock.mockImplementation(async () => limited());
    for (let i = 0; i < 20; i++) expect(await latestRelease()).toBe(VERSION);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(RETRY_AFTER_MS + 1);
    fetchMock.mockImplementation(async () => ok("v9.0.0"));
    await latestRelease();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await latestRelease()).toBe("9.0.0");
  });

  it("asks once an hour when GitHub answers", async () => {
    const { latestRelease, ASK_EVERY_MS } = await fresh();
    fetchMock.mockImplementation(async () => ok("v9.0.0"));
    for (let i = 0; i < 20; i++) expect(await latestRelease()).toBe("9.0.0");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(ASK_EVERY_MS + 1);
    await latestRelease();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares one ask between visits that arrive together", async () => {
    const { latestRelease } = await fresh();
    let answer: (r: Response) => void = () => {};
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (answer = resolve)));
    const visits = Array.from({ length: 10 }, () => latestRelease());
    answer(ok("v9.0.0"));
    expect(await Promise.all(visits)).toEqual(Array(10).fill("9.0.0"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a visit does not wait for a slow GitHub once an answer is known", async () => {
    const { latestRelease, ASK_EVERY_MS } = await fresh();
    fetchMock.mockImplementation(async () => ok("v9.0.0"));
    await latestRelease();
    vi.advanceTimersByTime(ASK_EVERY_MS + 1);
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    let done = false;
    const visit = latestRelease().then((v) => ((done = true), v));
    await settle();
    expect(done).toBe(true);
    expect(await visit).toBe("9.0.0");
  });
});

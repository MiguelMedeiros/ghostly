import { afterEach, describe, expect, it, vi } from "vitest";
import { boundedAppFetch } from "@ghostly/browser/engine/appFetch";
import { appsTestFetch } from "../../desktop/appsTestFetch";

// covers: apps.desktop-sandbox

/** The Desktop e2e build's test store (WISP 1200 § Stores): the engine's own checks still hold around it. */
describe("appsTestFetch", () => {
  afterEach(() => { delete (globalThis as { __ghostlyAppsStore?: string }).__ghostlyAppsStore; });

  const STORE = "https://raw.githubusercontent.com/ghostly-e2e/store/HEAD/ghostly-store.json";

  it("sends an allowed host's read to the spec's server, and the engine takes the answer", async () => {
    (globalThis as { __ghostlyAppsStore?: string }).__ghostlyAppsStore = "http://127.0.0.1:3851";
    const asked: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return Object.defineProperty(new Response(new Uint8Array([1, 2, 3])), "url", { value: String(input) });
    }) as unknown as typeof fetch;
    const read = boundedAppFetch({ fetcher: appsTestFetch(fetcher) });
    expect([...await read(STORE, { maxBytes: 10 })]).toEqual([1, 2, 3]);
    expect(asked).toEqual(["http://127.0.0.1:3851/raw.githubusercontent.com/ghostly-e2e/store/HEAD/ghostly-store.json"]);
  });

  it("leaves every read alone without the setting, and every other host with it", async () => {
    const fetcher = vi.fn(async () => new Response("x")) as unknown as typeof fetch;
    await appsTestFetch(fetcher)(STORE);
    (globalThis as { __ghostlyAppsStore?: string }).__ghostlyAppsStore = "http://127.0.0.1:3851";
    await appsTestFetch(fetcher)("https://example.com/x");
    expect(vi.mocked(fetcher).mock.calls.map((c) => c[0])).toEqual([STORE, "https://example.com/x"]);
    // The engine still refuses a host that is not on its list, before any fetcher.
    await expect(boundedAppFetch({ fetcher: appsTestFetch(fetcher) })("https://example.com/x", { maxBytes: 1 })).rejects.toThrow(/^host/);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

// covers: app.pwa.offline

/**
 * A build file the worker did not precache (Iroh's WebAssembly, each wallet's: 2 to 12 MiB), the first time it is
 * asked for. This runs the worker's own script (`apps/web/src/sw/sw.ts`) against a stand-in scope: the page compiles
 * these while they arrive, so the worker must answer when the download starts and store the file behind the answer.
 */
const ORIGIN = "https://app.ghostly.tools";
const WASM = "/assets/ghostly_iroh_web_bg-abc.wasm";

interface FetchEvent { request: Request; respondWith(response: Promise<Response> | Response): void; waitUntil(promise: Promise<unknown>): void }

/** The worker's script, started in a scope whose cache stores with `put`. Returns its `fetch` listener. */
async function startWorker(put: (key: string, response: Response) => Promise<void>) {
  const listeners = new Map<string, (event: FetchEvent) => void>();
  const cache = { match: async () => undefined, put };
  vi.stubGlobal("__SW_BUILD__", "test");
  vi.stubGlobal("__SW_PRECACHE__", ["/"]);
  vi.stubGlobal("caches", { open: async () => cache, match: async () => undefined });
  vi.stubGlobal("self", {
    location: { origin: ORIGIN },
    registration: { scope: `${ORIGIN}/` },
    addEventListener: (type: string, listener: (event: FetchEvent) => void) => { listeners.set(type, listener); },
  });
  vi.resetModules();
  await import("../../../../web/src/sw/sw");
  return listeners.get("fetch")!;
}

/** One request through the worker: what it answered with, and what it asked to be kept alive for. */
function ask(onFetch: (event: FetchEvent) => void, path: string) {
  let answer: Promise<Response> | undefined;
  const waited: Promise<unknown>[] = [];
  onFetch({
    request: new Request(ORIGIN + path),
    respondWith: (response) => { answer = Promise.resolve(response); },
    waitUntil: (promise) => { waited.push(promise); },
  });
  return { answer, waited };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a build file that is not precached", () => {
  it("is answered before it is stored: a store that never ends holds nothing back", async () => {
    const stored: string[] = [];
    const onFetch = await startWorker((key) => { stored.push(key); return new Promise(() => {}); });
    vi.stubGlobal("fetch", async () => new Response("wasm bytes"));

    const { answer, waited } = ask(onFetch, WASM);
    const response = await Promise.race([answer, new Promise<"held">((resolve) => setTimeout(() => resolve("held"), 200))]);

    expect(response).not.toBe("held");
    expect(await (response as Response).text()).toBe("wasm bytes");
    // Stored all the same, and the worker stays up until it is.
    expect(stored).toEqual([WASM]);
    expect(waited).toHaveLength(1);
  });

  it("is answered when the store fails, and the failure stays in the worker", async () => {
    const onFetch = await startWorker(() => Promise.reject(new Error("quota")));
    vi.stubGlobal("fetch", async () => new Response("wasm bytes"));

    const { answer, waited } = ask(onFetch, WASM);

    expect(await (await answer)!.text()).toBe("wasm bytes");
    await expect(Promise.all(waited)).resolves.toBeDefined();
  });

  it("is not stored when the answer is not the whole file", async () => {
    const stored: string[] = [];
    const onFetch = await startWorker(async (key) => { stored.push(key); });
    vi.stubGlobal("fetch", async () => new Response("gone", { status: 404 }));

    const { answer, waited } = ask(onFetch, WASM);

    expect((await answer)!.status).toBe(404);
    expect(stored).toEqual([]);
    expect(waited).toEqual([]);
  });
});

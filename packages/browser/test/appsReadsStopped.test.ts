import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { boundedAppFetch } from "../src/engine/appFetch";
import { BUNDLE_URL, FakeNet, STORE_URL, apps, bundle, emptyProfile, storeFiles } from "./appsSupport";
// covers: apps.engine.network

/*
 * A read whose bytes nobody will use is not left running on the person's link: the store index read beside a `.sig`
 * that failed is stopped, and an install screen opened again on the same URL waits on the read already under way.
 */

beforeEach(async () => { await emptyProfile(); });

/** A body sent when `release` is called (all of it), or never; `cancelled` once the reader let it go. */
function heldBody(bytes: Uint8Array) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const state = { cancelled: false, release };
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent) { controller.close(); return; }
      await released;
      sent = true;
      controller.enqueue(bytes);
    },
    cancel() { state.cancelled = true; },
  });
  return { body, state };
}

describe("reads nobody waits for", () => {
  it("a store's index read stops as soon as the ghostly-store.sig beside it fails", async () => {
    const { indexBytes } = await storeFiles();
    const index = heldBody(indexBytes);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === STORE_URL
      ? new Response(index.body, { status: 200 })
      : new Response(null, { status: 404 }));
    const a = apps(new FakeNet(), { fetch: boundedAppFetch({ fetcher }) });
    await expect(a.previewStore({ url: STORE_URL })).rejects.toThrow(/^status: The host answered 404/);
    await vi.waitFor(() => { expect(index.state.cancelled).toBe(true); });
  });

  it("a second preview of the same URL joins the read under way instead of starting another", async () => {
    const app = await bundle();
    const bodies: ReturnType<typeof heldBody>[] = [];
    const fetcher = vi.fn(async () => {
      const held = heldBody(app.bytes);
      bodies.push(held);
      return new Response(held.body, { status: 200 });
    });
    const a = apps(new FakeNet(), { fetch: boundedAppFetch({ fetcher }) });
    const first = a.preview({ url: BUNDLE_URL }); // the screen closed: nobody looks at it
    await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(1); });
    const second = a.preview({ url: BUNDLE_URL });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (const held of bodies) held.state.release();
    expect((await second).digest).toBe(app.digest);
    expect((await first).digest).toBe(app.digest);
    // Once it is over, a later preview reads the URL again.
    const third = a.preview({ url: BUNDLE_URL });
    await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(2); });
    bodies[1]!.state.release();
    expect((await third).digest).toBe(app.digest);
  });
});

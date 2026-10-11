import { desktopHome, expect, openDesktop, test } from "../support/desktop";

/**
 * A page holds its native listeners (eight Iroh endpoints at most, apps/desktop/src/paired_transport.rs) by ids only
 * it knows, and stops them itself. A page that went without stopping them (it was loaded again: another profile,
 * Clear all data, a device that became a standby; or its process died) left them running in Rust, where nothing could
 * stop them any more: with eight left behind, no chat of the app got a listener ("Native endpoint limit reached")
 * until the app was quit.
 *
 * The page here is the app's own. The listeners are asked for the way apps/ui/src/desktop/nativeTransports.ts asks, and
 * the page is loaded again the way a profile switch loads it (apps/ui/src/lib/profiles.ts).
 */

/** Starts `arguments[0]` Iroh listeners from the page: the ids it got, and what the app refused. */
const START = `
  const done = arguments[arguments.length - 1];
  const tauri = window.__TAURI_INTERNALS__;
  const seed = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  (async () => {
    const ids = [], refused = [];
    for (let i = 0; i < arguments[0]; i++) {
      const events = "__CHANNEL__:" + tauri.transformCallback(() => {});
      try { ids.push((await tauri.invoke("paired_iroh_start", { seedB64: seed(), events })).id); }
      catch (error) { refused.push(String(error)); }
    }
    done({ ids, refused });
  })();`;

type Started = { ids: number[]; refused: string[] };

test("a page loaded again finds its eight native listeners free", { tag: ["@feature:transport.native-pool"] }, async () => {
  const home = desktopHome("listeners");
  try {
    const { app, stop } = await openDesktop({ home: home.dir, profile: "listeners" });
    try {
      const loaded = () => expect.poll(() => app.execute<boolean>("return !!window.__TAURI_INTERNALS__ && document.readyState === 'complete' && !window.__leaving").catch(() => false),
        { message: "the page is up", timeout: 90_000 }).toBe(true);
      await loaded();
      const first = await app.executeAsync<Started>(START, 9);
      expect(first.ids, "eight listeners start").toHaveLength(8);
      expect(first.refused, "a ninth is refused").toEqual(["Native endpoint limit reached"]);

      // The page goes without stopping one of them.
      await app.execute("window.__leaving = true; location.reload();").catch(() => {});
      await loaded();

      const again = await app.executeAsync<Started>(START, 8);
      expect(again.refused, "nothing of the page before is in the way").toEqual([]);
      expect(again.ids).toHaveLength(8);
    } finally {
      await stop();
    }
  } finally {
    home.remove();
  }
});

import { describe, expect, it } from "vitest";
import { locales } from "../../locales";
import { translateWith } from "../../locales/translate";
import { appErrorCode, appErrorView } from "../../lib/apps/errors";
// covers: apps.page

/*
 * A browser that keeps no app files (Safari's Private Browsing, WebKit in memory): the engine's `storage` error carries
 * the browser's own words for the logs, and the person reads a short line with the story behind its ⓘ.
 */
const RAW = "storage: The app's files could not be stored on this device (UnknownError: Error preparing Blob/File data to be stored in object store)";

describe("app errors", () => {
  it("says a storage failure in words, with an ⓘ, and never the browser's", () => {
    const view = appErrorView(new Error(RAW), translateWith(locales.en));
    expect(view.text).toBe("This browser can't keep apps here (private browsing?). Try a normal window.");
    expect(view.info).toContain("Open Ghostly in a normal window");
    expect(`${view.text} ${view.info}`).not.toMatch(/Blob|IndexedDB|object store/);
    expect(appErrorCode(new Error(RAW))).toBe("storage");
    expect(appErrorView(new Error(RAW), translateWith(locales.pt)).text).toBe("Este navegador não consegue guardar apps aqui (navegação privada?). Tente uma janela normal.");
  });

  it("other errors have no ⓘ", () => {
    expect(appErrorView(new Error("offline: no network"), translateWith(locales.en))).toEqual({ text: "You are offline." });
  });
});

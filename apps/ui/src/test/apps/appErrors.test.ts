import { describe, expect, it } from "vitest";
import { LOCALES as locales } from "../i18n/locales";
import { translateWith } from "../../locales/translate";
import { appErrorCode, appErrorView, appStoreErrorView } from "../../lib/apps/errors";
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
    expect(view.info).toContain("Private windows, like Safari's Private Browsing, don't let it");
    expect(`${view.text} ${view.info}`).not.toMatch(/Blob|IndexedDB|object store/);
    expect(appErrorCode(new Error(RAW))).toBe("storage");
    expect(appErrorView(new Error(RAW), translateWith(locales.pt)).text).toBe("Este navegador não consegue guardar apps aqui (navegação privada?). Tente uma janela normal.");
  });

  it("a read cut on a slow link says it took too long there, not that the host could not be reached", () => {
    expect(appErrorView(new Error("slow: That took too long on this connection"), translateWith(locales.en)))
      .toEqual({ text: "That took too long on this connection. Try again on a faster one." });
  });

  it("a host's own trouble (5xx, 429) says try again later, not that nothing is at the link", () => {
    const en = translateWith(locales.en);
    expect(appErrorView(new Error("status: The host answered 404"), en).text).toBe("Nothing found at that link.");
    expect(appErrorView(new Error("status: The host answered 410"), en).text).toBe("Nothing found at that link.");
    expect(appErrorView(new Error("status: The host answered 500"), en).text).toBe("The host had a problem (error 500). Try again later.");
    expect(appErrorView(new Error("status: The host answered 503"), en).text).toBe("The host had a problem (error 503). Try again later.");
    expect(appErrorView(new Error("status: The host answered 429"), en).text).toBe("The host had a problem (error 429). Try again later.");
    expect(appErrorView(new Error("status: The host answered 500"), translateWith(locales.pt)).text).toBe("O servidor teve um problema (erro 500). Tente de novo mais tarde.");
  });

  it("a store refused says the link holds no valid store, its refusal behind the ⓘ; a store's other errors as any read", () => {
    const en = translateWith(locales.en);
    expect(appStoreErrorView(new Error("not-json: This is not a store Ghostly can read"), en))
      .toEqual({ text: "That link holds no valid store.", info: "not-json: This is not a store Ghostly can read" });
    expect(appStoreErrorView(new Error("bad-signature: This is not a store Ghostly can read"), en).text).toBe("That link holds no valid store.");
    expect(appStoreErrorView(new Error("status: The host answered 404"), en)).toEqual({ text: "Nothing found at that link." });
    expect(appStoreErrorView(new Error("network: Failed to fetch"), en)).toEqual({ text: "Could not reach the host." });
  });

  it("a store's older or too large list is said of the store's list, not of an app's version", () => {
    const en = translateWith(locales.en);
    expect(appStoreErrorView(new Error("rollback: This store's index is older than the one you have (sequence 4)"), en))
      .toEqual({ text: "This store's link now holds an older list than yours. Ghostly kept yours." });
    expect(appStoreErrorView(new Error("too-large: Too large"), en)).toEqual({ text: "This store's list is too large for Ghostly to read." });
  });

  it("other errors have no ⓘ", () => {
    expect(appErrorView(new Error("offline: no network"), translateWith(locales.en))).toEqual({ text: "You are offline." });
  });
});

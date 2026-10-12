import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPS_CAPABILITY } from "@ghostly/core";
import { Apps } from "../src/engine/apps";
import { appsChat } from "./helpers/appsChat";
// covers: apps.chat.wire

/**
 * An engine that runs no mini-app but speaks an app's messages itself (`apps: "wire"`; WISP 1200 § A bot on the other
 * side): it offers `apps/1` and takes the chat calls (`appId`, `appOpen`, `appClose`, `appSend`), and has no store: no
 * installed app, no store read, no update check, no app storage. Whatever the build's `APPS_ENABLED` says.
 */

vi.mock("../src/shared/features", async (actual) => ({ ...await actual<typeof import("../src/shared/features")>(), APPS_ENABLED: false }));

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const step of cleanup.splice(0).reverse()) await step(); });

describe('apps: "wire" in an engine', () => {
  it("offers apps/1 and talks to the contact's app, without the store", async () => {
    const started = vi.spyOn(Apps.prototype, "start");
    const asked = vi.spyOn(Apps.prototype, "chatRunnable");
    const { call, contact, contactGot, id, ref, app, appEvents } = await appsChat(cleanup, { apps: "wire" });
    expect(contact.sessionOffers.peer).toContain(APPS_CAPABILITY);
    await vi.waitFor(() => expect(contact.supportsApps).toBe(true));
    expect(await call("appId", { linkId: id, ref })).toEqual({ app });
    expect(await call("appOpen", { linkId: id, ref, version: "2.3.0" })).toEqual({ app });
    await vi.waitFor(() => expect(contactGot).toEqual([{ app, o: "open", v: "2.3.0" }]));
    contact.openApp(app, "2.3.0");
    await vi.waitFor(() => expect(appEvents().map(e => [e.linkId, e.event])).toEqual([[id, { app, o: "open", v: "2.3.0" }]]));
    expect(await call("appSend", { linkId: id, ref, data: { k: "hello" } })).toEqual({ error: null });
    await vi.waitFor(() => expect(contactGot.at(-1)).toEqual({ app, d: { k: "hello" } }));
    expect(contact.sendAppData(app, { k: "move" })).toBeNull();
    await vi.waitFor(() => expect(appEvents().at(-1)?.event).toEqual({ app, d: { k: "move" } }));
    await call("appClose", { linkId: id, ref });
    await vi.waitFor(() => expect(contactGot.at(-1)).toEqual({ app, o: "close" }));
    expect(await call("appSend", { linkId: id, ref, data: 1 })).toEqual({ error: "not-open" });
    expect(started).not.toHaveBeenCalled();
    expect(asked).not.toHaveBeenCalled();
  });

  it("refuses every call of the store, the installed apps and their storage", async () => {
    const { call, ref } = await appsChat(cleanup, { apps: "wire" });
    for (const [method, params] of [
      ["appList", undefined], ["appStoreList", undefined], ["appStoreAdd", { url: "https://raw.githubusercontent.com/o/r/HEAD/index.json" }],
      ["appStoreRefresh", undefined], ["appPreview", { url: "https://raw.githubusercontent.com/o/r/HEAD/app.ghostlyapp" }], ["appInstall", { digest: "x", grant: [] }],
      ["appCheckUpdates", undefined], ["appRunCheck", { ref }], ["appEntry", { ref }], ["appStorageGet", { ref, scope: "alone", key: "k" }], ["appDataExport", { ref }],
    ] as const)
      await expect(call(method, params), method).rejects.toThrow("Apps do not run on this client");
  });
});

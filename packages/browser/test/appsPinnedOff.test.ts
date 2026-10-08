import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPS_CAPABILITY } from "@ghostly/core";
import { APPS_ENABLED } from "../src/shared/features";
import { appsChat } from "./helpers/appsChat";
// covers: apps.chat.wire

/**
 * An engine that runs no mini-app pins `apps: false` (the CLI's and the extension's, WISP 1200 § Per client): it stays
 * off once the build turns apps on. Here the build's `APPS_ENABLED` is on, as in a release that ships apps.
 */

vi.mock("../src/shared/features", async (actual) => ({ ...await actual<typeof import("../src/shared/features")>(), APPS_ENABLED: true }));

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

describe("apps pinned off in an engine, with APPS_ENABLED on", () => {
  it("an engine that does not say is on: it offers apps/1 (the build's flag reaches it)", async () => {
    expect(APPS_ENABLED).toBe(true);
    const { call, contact, id, ref, app } = await appsChat(cleanup);
    await vi.waitFor(() => expect(contact.supportsApps).toBe(true));
    expect(await call("appId", { linkId: id, ref })).toEqual({ app });
  });

  it("apps: false offers no apps/1, refuses every app call, and drops what the contact sends", async () => {
    const { call, contact, id, ref, app, appEvents } = await appsChat(cleanup, { apps: false });
    expect(contact.sessionOffers.peer).not.toContain(APPS_CAPABILITY);
    expect(contact.supportsApps).toBe(false);
    for (const [method, params] of [
      ["appId", { linkId: id, ref }], ["appOpen", { linkId: id, ref, version: "1.0.0" }], ["appClose", { linkId: id, ref }], ["appSend", { linkId: id, ref, data: 1 }],
      ["appList", undefined], ["appStoreList", undefined], ["appStoreAdd", { url: "https://raw.githubusercontent.com/o/r/HEAD/index.json" }],
    ] as const)
      await expect(call(method, params), method).rejects.toThrow("Apps do not run on this client");
    contact.openApp(app, "1.0.0");
    (contact as unknown as { channel: { send(data: string): void } }).channel.send(JSON.stringify({ t: "paired-app", a: app, o: "open", v: "1.0.0" }));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(appEvents()).toEqual([]);
  });
});

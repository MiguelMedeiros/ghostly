import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPS_CAPABILITY } from "@ghostly/core";
import { APPS_ENABLED } from "../src/shared/features";
import { appsChat } from "./helpers/appsChat";
// covers: apps.chat.wire

/**
 * Mini-apps in the engine (WISP 1200 § In a chat: `apps/1`): the pages open an app in a paired chat by its reference,
 * talk to the same app on the contact's side through the engine's calls, and hear the contact's frames as `app-frame`
 * events. A real engine and its contact's link over a stand-in for Iroh, as reactions.test.ts does. Behind a flag
 * (`NodeOptions.apps`, by default `APPS_ENABLED`): off, nothing is offered and every call is refused.
 */

// The build's flag, off here whatever the constant says: a test that passes no `apps` reaches the default as dev ships it.
vi.mock("../src/shared/features", async (actual) => ({ ...await actual<typeof import("../src/shared/features")>(), APPS_ENABLED: false }));

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });
const setup = (options?: Parameters<typeof appsChat>[1]) => appsChat(cleanup, options);

describe("apps in the engine (apps/1)", () => {
  it("off: nothing is offered, every call is refused", async () => {
    // Off by the engine's option, so this holds whatever the build's APPS_ENABLED says.
    const { call, contact, id, ref, app, appEvents } = await setup({ apps: false });
    expect(contact.sessionOffers.peer).not.toContain(APPS_CAPABILITY);
    expect(contact.supportsApps).toBe(false);
    for (const [method, params] of [["appId", { linkId: id, ref }], ["appOpen", { linkId: id, ref, version: "1.0.0" }], ["appClose", { linkId: id, ref }], ["appSend", { linkId: id, ref, data: 1 }]] as const)
      await expect(call(method, params), method).rejects.toThrow("Apps are unavailable in this release");
    // What the contact says anyway is dropped.
    contact.openApp(app, "1.0.0");
    (contact as unknown as { channel: { send(data: string): void } }).channel.send(JSON.stringify({ t: "paired-app", a: app, o: "open", v: "1.0.0" }));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(appEvents()).toEqual([]);
  });

  it("an engine that does not say follows the build's flag: off, nothing is offered and every call is refused", async () => {
    // No `apps` option, as the pages' and the server's engines are made: the default is APPS_ENABLED (mocked off).
    expect(APPS_ENABLED).toBe(false);
    const { call, contact, id, ref } = await setup();
    expect(contact.sessionOffers.peer).not.toContain(APPS_CAPABILITY);
    expect(contact.supportsApps).toBe(false);
    for (const [method, params] of [
      ["appId", { linkId: id, ref }], ["appOpen", { linkId: id, ref, version: "1.0.0" }], ["appList", undefined], ["appStoreList", undefined],
    ] as const)
      await expect(call(method, params), method).rejects.toThrow("Apps are unavailable in this release");
  });

  it("on: the page opens an app by its reference, the contact hears it under the same chat app id, and they talk", async () => {
    const { call, contact, contactGot, id, ref, app, appEvents } = await setup({ apps: true });
    await vi.waitFor(() => expect(contact.supportsApps).toBe(true));
    expect(await call("appId", { linkId: id, ref })).toEqual({ app });
    expect(await call("appOpen", { linkId: id, ref, version: "1.0.0" })).toEqual({ app });
    await vi.waitFor(() => expect(contactGot).toEqual([{ app, o: "open", v: "1.0.0" }]));
    // The contact has not opened it yet.
    expect(await call("appSend", { linkId: id, ref, data: { move: "e2e4" } })).toEqual({ error: "peer-closed" });
    contact.openApp(app, "1.0.1");
    await vi.waitFor(() => expect(appEvents().map(e => [e.linkId, e.event])).toEqual([[id, { app, o: "open", v: "1.0.1" }]]));
    expect(await call("appSend", { linkId: id, ref, data: { move: "e2e4" } })).toEqual({ error: null });
    await vi.waitFor(() => expect(contactGot.at(-1)).toEqual({ app, d: { move: "e2e4" } }));
    expect(contact.sendAppData(app, { move: "e7e5" })).toBeNull();
    await vi.waitFor(() => expect(appEvents().at(-1)?.event).toEqual({ app, d: { move: "e7e5" } }));
    expect(await call("appSend", { linkId: id, ref, data: "x".repeat(32 * 1024) })).toEqual({ error: "too-large" });
    await call("appClose", { linkId: id, ref });
    await vi.waitFor(() => expect(contactGot.at(-1)).toEqual({ app, o: "close" }));
    expect(await call("appSend", { linkId: id, ref, data: 1 })).toEqual({ error: "not-open" });
  });

  it("on: refuses what is not an app reference, a version, or a paired chat", async () => {
    const { call, id, ref } = await setup({ apps: true });
    await expect(call("appOpen", { linkId: id, ref: "chess", version: "1.0.0" })).rejects.toThrow("Not an app reference");
    await expect(call("appOpen", { linkId: id, ref, version: "1.0" })).rejects.toThrow("Not an app version");
    await expect(call("appOpen", { linkId: "nope", ref, version: "1.0.0" })).rejects.toThrow("No such chat");
  });

  it("on: the contact's app without apps/1 (an older app) gets no frame, and a send says so", async () => {
    const { call, contact, contactGot, id, ref } = await setup({ apps: true, contactApps: false });
    expect(contact.sessionOffers.peer).toContain(APPS_CAPABILITY);
    await call("appOpen", { linkId: id, ref, version: "1.0.0" });
    expect(await call("appSend", { linkId: id, ref, data: 1 })).toEqual({ error: "peer-closed" });
    await call("appClose", { linkId: id, ref });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(contactGot).toEqual([]);
  });

  it("on: when the last page goes, its apps close and the contact hears it", async () => {
    const { server, page, call, contact, contactGot, id, ref, app } = await setup({ apps: true });
    await vi.waitFor(() => expect(contact.supportsApps).toBe(true));
    await call("appOpen", { linkId: id, ref, version: "1.0.0" });
    await vi.waitFor(() => expect(contactGot).toEqual([{ app, o: "open", v: "1.0.0" }]));
    server.detach(page);
    await vi.waitFor(() => expect(contactGot.at(-1)).toEqual({ app, o: "close" }));
  });

  it("on: an app opened while the chat is offline says open once the session is live", async () => {
    const offline: unknown[] = [];
    const { contactGot, app } = await setup({ apps: true, beforeLive: async (call, linkId, ref) => {
      await call("appOpen", { linkId, ref, version: "1.0.0" });
      offline.push(await call("appSend", { linkId, ref, data: 1 }));
    } });
    // Nothing was kept to send later: only the open goes.
    expect(offline).toEqual([{ error: "offline" }]);
    await vi.waitFor(() => expect(contactGot).toEqual([{ app, o: "open", v: "1.0.0" }]));
  });
});

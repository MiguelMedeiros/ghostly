import { beforeEach, describe, expect, it, vi } from "vitest";
import { engine, bootExtension } from "./extension";
import { resetEngine } from "./fakeEngine";

// covers: extension.engine

vi.mock("@ghostly/browser/engine/server", async () => (await import("./fakeEngine")).engineServerModule);
// A build that turns apps on (the release that ships them): the extension's engine still runs none.
vi.mock("@ghostly/browser/shared/features", async (actual) => ({ ...await actual<typeof import("@ghostly/browser/shared/features")>(), APPS_ENABLED: true }));

/**
 * The extension has no mini-app runner (WISP 1200 § Per client: Extension, later), so its engine is made with
 * `apps: false`: no apps/1 offered to a contact and every app call refused, whatever `APPS_ENABLED` says. That an
 * engine made so stays off with the flag on is packages/browser/test/appsPinnedOff.test.ts.
 */

beforeEach(() => {
  resetEngine();
});

describe("the extension's engine with APPS_ENABLED on", () => {
  it("is made with apps off", async () => {
    expect((await import("@ghostly/browser/shared/features")).APPS_ENABLED).toBe(true);
    const world = await bootExtension();
    expect(await world.chrome.runtime.sendMessage({ target: "background", type: "ensure-engine" })).toEqual({ ok: true });
    expect(engine().options).toMatchObject({ apps: false });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredService } from "@ghostly/browser/shared/types";
import { settle, type FakeWorld } from "./fakeChrome";
import { engineControl, resetEngine } from "./fakeEngine";
import { PEER, bootExtension, engine } from "./extension";

// covers: services.stop

vi.mock("@ghostly/browser/engine/server", async () => (await import("./fakeEngine")).engineServerModule);

/**
 * Turning off the extension's site access to a host (`chrome://extensions` → Site access, or the puzzle menu) is how the
 * person stops it reaching their machine's apps there: those apps stop being shared, as "Share" turned off does, and
 * contacts asking for one are answered as for any app not shared.
 */

let world: FakeWorld;

const app = (id: string, target: string): StoredService => ({ id, name: id, target, enabled: true, sharedWith: [PEER], createdAt: 0 });
const shared = () => engine().node.getState().services.filter((s) => s.enabled).map((s) => s.id);

beforeEach(async () => {
  resetEngine().services = [app("atlas", "http://127.0.0.1:3400"), app("notes", "http://127.0.0.1:5000/notes"), app("wiki", "http://localhost:3400")];
  world = await bootExtension();
  world.hostAccess.add("http://127.0.0.1/*");
  world.hostAccess.add("http://localhost/*");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("site access to a local host taken back in Chrome", () => {
  it("stops sharing every app at that host, and a contact's request for one is refused", async () => {
    expect(engine().node.serves("atlas", PEER)).toBe(true);
    world.revokeHostAccess("http://127.0.0.1/*");
    await settle();
    // Every port of that host goes; an app at another host keeps its own access.
    expect(shared()).toEqual(["wiki"]);
    expect(engine().node.serves("atlas", PEER)).toBe(false);
    expect(engine().node.serves("notes", PEER)).toBe(false);
    expect(engine().node.serves("wiki", PEER)).toBe(true);
  });

  it("turns off nothing for a host no app is at, even the same name over https", async () => {
    world.hostAccess.add("https://localhost/*");
    world.revokeHostAccess("https://localhost/*");
    await settle();
    expect(shared()).toEqual(["atlas", "notes", "wiki"]);
  });

  it("reaches the peer when no document runs, starting it", async () => {
    world.endOffscreen();
    const services = engineControl().services;
    resetEngine().services = services;
    world.revokeHostAccess("http://localhost/*");
    await settle(40);
    expect(shared()).toEqual(["atlas", "notes"]);
  });
});

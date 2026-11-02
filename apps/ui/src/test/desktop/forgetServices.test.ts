import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// covers: services.desktop-viewer

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
  listen: async () => () => {},
  getIdentifier: async () => "app.ghostly.chat",
  convertFileSrc: (path: string) => path,
  Channel: class {},
}));
// The options the host is made with, as they are.
vi.mock("@ghostly/browser/inPageHost", () => ({ createInPageHost: (options: unknown) => options }));

import { invoke } from "@tauri-apps/api/core";
import { createDesktopHost } from "../../desktop/host";
import { OPENED_KEY } from "../../lib/openedServices";

/*
 * A contact's app on Desktop runs in a viewer window on `ghostly-svc://<service>.<peer>.<tag>/`, and what it keeps
 * there lands in the webview's storage, shared by every profile, in folders named after that origin. The host notes
 * each app it opens, and Delete chat, Clear all data and Delete profile (`forgetServices`) have Rust forget those
 * origins (apps/desktop/src/forget_origins.rs).
 */

type Host = {
  openService(peer: string, service: string, tag: string): Promise<void>;
  forgetServices?(which: { tag: string } | { profile: string }): Promise<void>;
};
const called = vi.mocked(invoke) as unknown as ReturnType<typeof vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>>;
const host = () => createDesktopHost("1.2.0") as unknown as Host;
const forgotten = () => called.mock.calls.filter(([name]) => name === "forget_service_origins").map(([, args]) => args!.origins);
const listed = () => JSON.parse(localStorage.getItem(OPENED_KEY) ?? "null") as unknown;

const PEER = "a".repeat(52);
const OTHER = "b".repeat(52);
const TAG_A = "ybndrfg8ejkmcpqx";
const TAG_B = "ot1uwisza345h769";

beforeEach(() => localStorage.clear());
afterEach(() => {
  called.mockReset();
  called.mockImplementation(async () => undefined);
});

describe("Desktop forgets what a contact's app kept", () => {
  it("notes each app it opens, once, before its window opens", async () => {
    const desktop = host();
    called.mockImplementation(async (command) => {
      if (command === "open_service_window") expect(listed(), "noted before the window").not.toBeNull();
      return undefined;
    });
    await desktop.openService(PEER, "keeper", TAG_A);
    await desktop.openService(PEER, "keeper", TAG_A);
    await desktop.openService(OTHER, "notes", TAG_B);
    expect(listed()).toEqual([
      { profile: "", tag: TAG_A, service: "keeper", peer: PEER },
      { profile: "", tag: TAG_B, service: "notes", peer: OTHER },
    ]);
  });

  it("has Rust forget the deleted chat's origins, and takes each one cleared off the list", async () => {
    const desktop = host();
    await desktop.openService(PEER, "keeper", TAG_A);
    await desktop.openService(PEER, "notes", TAG_A);
    await desktop.openService(OTHER, "keeper", TAG_B);
    called.mockImplementation(async (command) => (command === "forget_service_origins" ? [true] : undefined));
    expect(desktop.forgetServices, "Desktop forgets them").toBeTypeOf("function");
    await desktop.forgetServices!({ tag: TAG_A });
    expect(forgotten()).toEqual([[{ service: "keeper", peer: PEER, tag: TAG_A }], [{ service: "notes", peer: PEER, tag: TAG_A }]]);
    expect(listed()).toEqual([{ profile: "", tag: TAG_B, service: "keeper", peer: OTHER }]);
    // The last one goes with the profile, and the list with it: it names contacts.
    await desktop.forgetServices!({ profile: "" });
    expect(localStorage.getItem(OPENED_KEY)).toBeNull();
  });

  it("keeps on the list an origin Rust did not clear, or failed on, for the next clear", async () => {
    const desktop = host();
    await desktop.openService(PEER, "keeper", TAG_A);
    await desktop.openService(PEER, "notes", TAG_A);
    await desktop.openService(OTHER, "maps", TAG_A);
    called.mockImplementation(async (command, args) => {
      if (command !== "forget_service_origins") return undefined;
      const [{ service }] = args!.origins as { service: string }[];
      if (service === "notes") throw new Error("Window: no display");
      // A platform that clears none yet (macOS, Windows) answers false.
      return [service !== "keeper"];
    });
    await desktop.forgetServices!({ tag: TAG_A });
    expect(forgotten()).toHaveLength(3);
    expect((listed() as { service: string }[]).map((o) => o.service)).toEqual(["keeper", "notes"]);
  });

  it("never forgets another profile's", async () => {
    const desktop = host();
    await desktop.openService(PEER, "keeper", TAG_A);
    localStorage.setItem(OPENED_KEY, JSON.stringify([...(listed() as object[]), { profile: "work000001", tag: TAG_B, service: "keeper", peer: PEER }]));
    called.mockImplementation(async (command) => (command === "forget_service_origins" ? [true] : undefined));
    await desktop.forgetServices!({ profile: "work000001" });
    expect(forgotten()).toEqual([[{ service: "keeper", peer: PEER, tag: TAG_B }]]);
    expect(listed()).toEqual([{ profile: "", tag: TAG_A, service: "keeper", peer: PEER }]);
  });

  it("reads past entries that name no origin a viewer opens, and never sends them", async () => {
    localStorage.setItem(OPENED_KEY, JSON.stringify([
      { profile: "", tag: TAG_A, service: "kee/per", peer: PEER },
      { profile: "", tag: "short", service: "keeper", peer: PEER },
      { profile: "", tag: TAG_A, service: "keeper" },
      { profile: "", tag: TAG_A, label: "y".repeat(32) },
      null,
    ]));
    await host().forgetServices!({ profile: "" });
    expect(forgotten()).toEqual([]);
  });
});

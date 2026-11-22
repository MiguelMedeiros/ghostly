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
// The profile's chats, as the engine sends them while it starts.
const fakeEngine = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    state: null as null | { transfersRestored?: boolean; links: { myPubKeyZ32: string }[]; edges?: { myPubKeyZ32: string }[] },
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    linkByPeer: () => undefined,
    send(state: NonNullable<typeof fakeEngine.state>) { fakeEngine.state = state; for (const listener of [...listeners]) listener(); },
    reset() { fakeEngine.state = null; listeners.clear(); },
  };
});
vi.mock("@ghostly/browser/platform/engine", async (original) => ({ ...(await original<object>()), engine: fakeEngine }));

import { invoke } from "@tauri-apps/api/core";
import { viewerTag } from "@ghostly/core";
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

beforeEach(() => {
  localStorage.clear();
  fakeEngine.reset();
});
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
    // Then the whole chat: an app it opened before the list was kept is on no list.
    expect(forgotten()).toEqual([[{ service: "keeper", peer: PEER, tag: TAG_A }], [{ service: "notes", peer: PEER, tag: TAG_A }], [{ tag: TAG_A }]]);
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
      const [{ service }] = args!.origins as { service?: string }[];
      if (service === "notes") throw new Error("Window: no display");
      // A platform that clears none yet answers false.
      return [service !== "keeper" && service !== undefined];
    });
    await desktop.forgetServices!({ tag: TAG_A });
    expect(forgotten()).toHaveLength(4);
    expect(listed()).toEqual([
      { profile: "", tag: TAG_A, service: "keeper", peer: PEER },
      { profile: "", tag: TAG_A, service: "notes", peer: PEER },
      { profile: "", tag: TAG_A },
    ]);
  });

  it("notes each chat of the profile once at start, so an app opened before the list was kept goes with Delete chat", async () => {
    const [ME_A, ME_B, ME_GROUP] = ["me-a", "me-b", "me-group"];
    // An app of the chat with A was opened by an older version: nothing on the list names it.
    const desktop = host();
    fakeEngine.send({ links: [{ myPubKeyZ32: ME_A }] });
    expect(listed(), "not before every chat is loaded").toBeNull();
    fakeEngine.send({ transfersRestored: true, links: [{ myPubKeyZ32: ME_A }, { myPubKeyZ32: ME_B }], edges: [{ myPubKeyZ32: ME_GROUP }] });
    const tags = [ME_A, ME_B, ME_GROUP].map(viewerTag);
    expect(listed()).toEqual(tags.map((tag) => ({ profile: "", tag })));

    called.mockImplementation(async (command) => (command === "forget_service_origins" ? [true] : undefined));
    await desktop.forgetServices!({ tag: tags[0] });
    expect(forgotten(), "Rust clears every origin of the chat").toEqual([[{ tag: tags[0] }]]);
    expect(listed()).toEqual(tags.slice(1).map((tag) => ({ profile: "", tag })));

    // Once per profile: a later start notes no chat again.
    localStorage.removeItem(OPENED_KEY);
    host();
    fakeEngine.send({ transfersRestored: true, links: [{ myPubKeyZ32: ME_A }] });
    expect(listed()).toBeNull();
  });

  it("has Rust clear every chat it noted with the profile's data", async () => {
    const desktop = host();
    fakeEngine.send({ transfersRestored: true, links: [{ myPubKeyZ32: "me-a" }] });
    called.mockImplementation(async (command) => (command === "forget_service_origins" ? [true] : undefined));
    await desktop.forgetServices!({ profile: "" });
    expect(forgotten()).toEqual([[{ tag: viewerTag("me-a") }]]);
    expect(listed()).toBeNull();
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

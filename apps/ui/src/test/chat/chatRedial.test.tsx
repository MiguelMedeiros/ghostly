import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { LinkView } from "@ghostly/browser/shared/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { REDIAL_AFTER_DROP_MS, REDIAL_FIRST_MS, REDIAL_MAX_MS, useChatRedial } from "../../hooks/useChatRedial";

// covers: chat.paired.reconnect

/*
 * A chat on screen that is not live, on the side that does not dial by itself (the contact's app has the lower key),
 * goes on trying the dial Reconnect makes: at once as it opens, after each wait while it stays open and in sight, and
 * at once when the page shows again or the device is back online. It stops once live or closed.
 */

/** A paired chat, its contact pinned and seen, not live, waiting for the contact's dial. */
const notLive = (patch: Partial<LinkView> = {}): LinkView => linkView({
  profile: "paired-chat/1", peerParticipationKey: "pk", liveDialer: "contact", peerOnline: true,
  dataLink: "idle", status: "online", pairing: { status: "connecting" }, ...patch,
});
const live = (): LinkView => notLive({ dataLink: "open", pairing: { status: "ready", transport: "webrtc/1" } });

let visibility: DocumentVisibilityState = "visible";
const setVisibility = (state: DocumentVisibilityState) => {
  visibility = state;
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
};
/** Lets `ms` of the faked clock pass, and what it started settle (the fake engine answers in a microtask). */
const later = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const dials = () => fakeEngine.callsTo("connect").length;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  fakeEngine.reset();
  // The contact's app does not answer: each dial fails, as Reconnect's does then.
  fakeEngine.on("connect", () => { throw new Error("Timed out connecting to the peer"); });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("A chat opened while not live", () => {
  it("is dialled at once, the dial Reconnect makes", async () => {
    fakeEngine.setState({ links: [notLive()] });
    renderHook(() => useChatRedial("link-1"));
    await later(0);
    expect(fakeEngine.callsTo("connect")).toEqual([{ linkId: "link-1" }]);
  });

  it("is dialled again after 20 s, 40 s, 80 s and so on up to 3 minutes, never sooner", async () => {
    fakeEngine.setState({ links: [notLive()] });
    renderHook(() => useChatRedial("link-1"));
    await later(0);
    expect(dials()).toBe(1);
    let expected = 1;
    for (const wait of [REDIAL_FIRST_MS, 2 * REDIAL_FIRST_MS, 4 * REDIAL_FIRST_MS, 8 * REDIAL_FIRST_MS, REDIAL_MAX_MS, REDIAL_MAX_MS]) {
      await later(wait - 1_000);
      expect(dials()).toBe(expected);
      await later(1_000);
      expect(dials()).toBe(++expected);
    }
  });

  it("waits for the dial under way to settle before the next", async () => {
    // A dial the engine holds open (an offer the contact has not answered yet, up to 90 s).
    let settle!: () => void;
    fakeEngine.on("connect", () => new Promise<void>((_, reject) => { settle = () => reject(new Error("Timed out connecting to the peer")); }));
    fakeEngine.setState({ links: [notLive()] });
    renderHook(() => useChatRedial("link-1"));
    await later(0);
    await later(REDIAL_MAX_MS);
    expect(dials()).toBe(1);
    act(() => settle());
    await later(REDIAL_FIRST_MS);
    expect(dials()).toBe(2);
  });

  it("is dialled at once when the page shows again, and not while it is hidden", async () => {
    fakeEngine.setState({ links: [notLive()] });
    renderHook(() => useChatRedial("link-1"));
    await later(0);
    setVisibility("hidden");
    await later(10 * REDIAL_MAX_MS);
    expect(dials()).toBe(1);
    // Back in front: now, not after the wait it was in.
    setVisibility("visible");
    await later(0);
    expect(dials()).toBe(2);
    // And the wait starts over: the next after 20 s.
    await later(REDIAL_FIRST_MS);
    expect(dials()).toBe(3);
  });

  it("is dialled at once when the device is back online", async () => {
    fakeEngine.setState({ links: [notLive()] });
    renderHook(() => useChatRedial("link-1"));
    await later(0);
    await later(REDIAL_FIRST_MS);
    expect(dials()).toBe(2);
    // In the 40 s wait now: the network comes back.
    await later(10_000);
    act(() => { window.dispatchEvent(new Event("online")); });
    await later(0);
    expect(dials()).toBe(3);
  });

  it("never dials twice within a few seconds, however often the page shows", async () => {
    fakeEngine.setState({ links: [notLive()] });
    renderHook(() => useChatRedial("link-1"));
    await later(0);
    for (let i = 0; i < 5; i++) { setVisibility("hidden"); setVisibility("visible"); await later(200); }
    expect(dials()).toBe(1);
  });

  it("stops once the chat is live, and starts over from the first wait after a later drop", async () => {
    fakeEngine.setState({ links: [notLive()] });
    renderHook(() => useChatRedial("link-1"));
    await later(0);
    act(() => fakeEngine.setState({ links: [live()] }));
    await later(10 * REDIAL_MAX_MS);
    expect(dials()).toBe(1);
    // Dropped: the contact's app dials it again first; this side's dial comes once that had its time.
    act(() => fakeEngine.setState({ links: [notLive({ transportHistory: [{ at: Date.now(), kind: "down" }] })] }));
    await later(REDIAL_AFTER_DROP_MS - 1_000);
    expect(dials()).toBe(1);
    await later(1_000);
    expect(dials()).toBe(2);
  });

  it("stops once the chat is closed", async () => {
    fakeEngine.setState({ links: [notLive()] });
    const { rerender, unmount } = renderHook(({ id }) => useChatRedial(id), { initialProps: { id: "link-1" as string | null } });
    await later(0);
    rerender({ id: null });
    await later(10 * REDIAL_MAX_MS);
    expect(dials()).toBe(1);
    rerender({ id: "link-1" });
    await later(0);
    expect(dials()).toBe(2);
    unmount();
    await later(10 * REDIAL_MAX_MS);
    expect(dials()).toBe(2);
  });
});

describe("A chat this app does not dial for", () => {
  it.each<[string, Partial<LinkView>]>([
    ["the side whose engine dials by itself", { liveDialer: "you" }],
    ["a contact not seen", { peerOnline: false }],
    ["DHT only, chosen here", { deliveryMode: "dht" }],
    ["DHT only, chosen by the contact", { dhtDelivery: { peerMode: "dht" } as LinkView["dhtDelivery"] }],
    ["an offer on its way", { dataLink: "answering" }],
    ["a contact not pinned yet", { peerParticipationKey: undefined }],
    ["a first pairing under way", { pairingProgress: { stage: "answering" } as LinkView["pairingProgress"] }],
  ])("%s is left alone", async (_, patch) => {
    fakeEngine.setState({ links: [notLive(patch)] });
    renderHook(() => useChatRedial("link-1"));
    await later(10 * REDIAL_MAX_MS);
    expect(dials()).toBe(0);
  });

  it("Ghostly offline is left alone", async () => {
    fakeEngine.setState({ links: [notLive()], settings: { online: false } });
    renderHook(() => useChatRedial("link-1"));
    await later(10 * REDIAL_MAX_MS);
    expect(dials()).toBe(0);
  });

  it("a contact seen again is dialled at once, whatever wait it was in", async () => {
    fakeEngine.setState({ links: [notLive()] });
    renderHook(() => useChatRedial("link-1"));
    await later(0);
    await later(REDIAL_FIRST_MS + 2 * REDIAL_FIRST_MS);
    expect(dials()).toBe(3);
    act(() => fakeEngine.setState({ links: [notLive({ peerOnline: false })] }));
    await later(10_000);
    act(() => fakeEngine.setState({ links: [notLive()] }));
    await later(0);
    expect(dials()).toBe(4);
  });
});

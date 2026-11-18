import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { ChatConnection } from "../../components/ChatConnection";
import { SAID_QUIET_MS } from "../../hooks/useSaidSettled";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { LOCALES } from "../i18n/locales";
import { translateWith } from "../../locales/translate";

// covers: transport.indicator, chat.paired.status

type Pairing = NonNullable<LinkView["pairing"]>;
const all = ["webrtc/1", "iroh/1", "hyperdht/1"] as LinkView["availableTransports"];
/** Live over WebRTC, as the contact's app keeps it between two drops. */
const live = () => linkView({ availableTransports: all, peerTransports: all, peerNick: "Ana", peerParticipationKey: "pk", dataLink: "open", textDelivery: "stream",
  pairing: { status: "ready", transport: "webrtc/1" } as Pairing, transportHistory: [{ at: Date.now(), kind: "live", transport: "webrtc/1" }] as LinkView["transportHistory"] });
/** The link just dropped: texts go on the DHT, and the engine wrote its `down` row. */
const down = () => linkView({ availableTransports: all, peerTransports: all, peerNick: "Ana", peerParticipationKey: "pk", dataLink: "idle", textDelivery: "dht",
  pairing: { status: "connecting" } as Pairing, transportHistory: [{ at: Date.now(), kind: "down", from: "webrtc/1", text: "dht" }] as LinkView["transportHistory"] });

/** What a screen reader is told: the header's polite live region, each time its words change. */
function listen() {
  const said: string[] = [];
  const region = () => document.querySelector(".sr-only[aria-live=polite]");
  let last = region()?.textContent ?? "";
  const observer = new MutationObserver(() => { const now = region()?.textContent ?? ""; if (now !== last) { last = now; said.push(now); } });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  return { said, stop: () => observer.disconnect() };
}
const flush = () => new Promise<void>(resolve => queueMicrotask(resolve));
const wait = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); await flush(); });

describe.each(["en", "ar"] as const)("a link that flaps is said where it settles, once (%s)", language => {
  const t = translateWith(LOCALES[language], language);
  // A drop is "On DHT", plainly, for its first seconds (CLOSED_QUIET_MS): the contact may have chosen DHT only.
  const connected = t("connection.state.connected", { transport: "WebRTC" }), onDht = t("connection.state.onDhtPlain");

  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); });
  afterEach(() => { vi.useRealTimers(); });

  /** A chat live over WebRTC long enough that the region said so. */
  async function settledLive() {
    const view = renderApp(<ChatConnection peerKey="peer" />, { language });
    act(() => view.engine.update({ links: [live()] }));
    await wait(SAID_QUIET_MS);
    expect(document.querySelector(".sr-only[aria-live=polite]")).toHaveTextContent(connected);
    return view;
  }

  it("five flaps in 20 s say nothing when the link ends where it started, and only where it lands when it stays down", async () => {
    const { engine } = await settledLive();
    const ear = listen();
    for (let i = 0; i < 5; i++) {
      act(() => engine.update({ links: [down()] }));
      await wait(2_000);
      act(() => engine.update({ links: [live()] }));
      await wait(2_000);
    }
    await wait(SAID_QUIET_MS);
    // On dev: ten, every drop and every return.
    expect(ear.said).toEqual([]);
    // The same flaps, then a drop that lasts: said once, after it held.
    for (let i = 0; i < 5; i++) {
      act(() => engine.update({ links: [down()] }));
      await wait(2_000);
      act(() => engine.update({ links: [live()] }));
      await wait(2_000);
    }
    act(() => engine.update({ links: [down()] }));
    await wait(SAID_QUIET_MS);
    ear.stop();
    expect(ear.said).toEqual([onDht]);
  });

  it("says a change that holds once, after the quiet window, while the header shows it at once", async () => {
    const { engine } = await settledLive();
    const ear = listen();
    act(() => engine.update({ links: [down()] }));
    // Shown at once: the icon's state, its name, the panel and the tooltip.
    const trigger = screen.getByTestId("connection-options");
    expect(trigger).toHaveAttribute("data-state", "dht");
    expect(trigger.getAttribute("aria-label")).toContain(onDht);
    expect(screen.getByTestId("connection-state")).toHaveTextContent(onDht);
    expect(screen.getByTestId("connection-tooltip")).toHaveTextContent(onDht);
    // Not said yet.
    await wait(0);
    expect(ear.said).toEqual([]);
    await wait(SAID_QUIET_MS - 1);
    expect(ear.said).toEqual([]);
    await wait(1);
    expect(ear.said).toEqual([onDht]);
    await wait(SAID_QUIET_MS * 3);
    ear.stop();
    expect(ear.said).toEqual([onDht]);
  });

  it("says Offline at once, and a network that flaps says it once, not at every return", async () => {
    const { engine } = await settledLive();
    const ear = listen();
    act(() => engine.update({ settings: { online: false } }));
    // At once: no window passed (a mutation is told at the next microtask).
    await wait(0);
    expect(ear.said).toEqual([t("connection.state.offline")]);
    for (let i = 0; i < 4; i++) {
      act(() => engine.update({ settings: { online: true } }));
      await wait(1_000);
      act(() => engine.update({ settings: { online: false } }));
      await wait(1_000);
    }
    expect(ear.said).toEqual([t("connection.state.offline")]);
    // Back for good: said once it held.
    act(() => engine.update({ settings: { online: true } }));
    await wait(SAID_QUIET_MS);
    ear.stop();
    expect(ear.said).toEqual([t("connection.state.offline"), connected]);
  });

  it("says a connection issue at once", async () => {
    const { engine } = await settledLive();
    const ear = listen();
    act(() => engine.update({ links: [linkView({ ...live(), pairing: { status: "ready", transport: "webrtc/1", transitionError: "Iroh did not answer" } as Pairing })] }));
    await wait(0);
    ear.stop();
    expect(ear.said).toEqual([t("connection.state.issue")]);
  });

  it("says nothing, and leaves no timer, when the chat closes mid-window", async () => {
    const { engine, unmount } = await settledLive();
    const ear = listen();
    act(() => engine.update({ links: [down()] }));
    await wait(SAID_QUIET_MS / 2);
    ear.stop();
    expect(ear.said).toEqual([]);
    const pending = vi.getTimerCount();
    unmount();
    expect(vi.getTimerCount()).toBeLessThan(pending);
    await wait(SAID_QUIET_MS);
  });
});

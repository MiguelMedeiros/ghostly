import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { ChatConnection, MOVE_QUIET_MS } from "../../components/ChatConnection";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: transport.indicator, transport.iroh-web

type Pairing = NonNullable<LinkView["pairing"]>;
/** Two browsers on Automatic: both run WebRTC and Iroh, and a browser's Iroh always goes through its relay. */
const web: Partial<LinkView> = {
  availableTransports: ["iroh/1", "webrtc/1"], peerTransports: ["iroh/1", "webrtc/1"], relayedTransports: ["iroh/1"], transportAutomatic: true,
};
const onDht = linkView({ ...web, dataLink: "idle", textDelivery: "dht", pairing: { status: "waiting" } as Pairing });
const onIroh = linkView({ ...web, dataLink: "open", pairing: { status: "ready", transport: "iroh/1" } as Pairing, transportRelayed: { relays: ["127.0.0.1"] } });
const onWebrtc = linkView({ ...web, dataLink: "open", pairing: { status: "ready", transport: "webrtc/1" } as Pairing });

/** What a screen reader is told: the header's polite live region, each time its words change. */
function listen() {
  const said: string[] = [];
  const region = () => document.querySelector(".sr-only[aria-live=polite]");
  let last = region()?.textContent ?? "";
  const observer = new MutationObserver(() => { const now = region()?.textContent ?? ""; if (now !== last) { last = now; said.push(now); } });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  return { said, stop: () => observer.disconnect() };
}
const flush = () => new Promise<void>(resolve => queueMicrotask(resolve));

describe("a chat back on Automatic over Iroh's relay, on its way to WebRTC", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("says only where it lands: not the relayed Iroh it moves off a moment later", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { engine } = renderApp(<ChatConnection peerKey="peer" />);
    act(() => engine.update({ links: [onDht] }));
    const ear = listen();
    // As measured between two browsers at a reload: live over the relay, then on WebRTC about 250 ms later.
    act(() => engine.update({ links: [onIroh] }));
    await act(async () => { vi.advanceTimersByTime(250); await flush(); });
    act(() => engine.update({ links: [onWebrtc] }));
    await act(async () => { vi.advanceTimersByTime(MOVE_QUIET_MS); await flush(); });
    ear.stop();
    expect(ear.said).toEqual(["Connected · WebRTC"]);
  });

  it("still says the relayed Iroh once the move has not come", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { engine } = renderApp(<ChatConnection peerKey="peer" />);
    act(() => engine.update({ links: [onDht] }));
    const ear = listen();
    act(() => engine.update({ links: [onIroh] }));
    await act(async () => { vi.advanceTimersByTime(MOVE_QUIET_MS); await flush(); });
    ear.stop();
    expect(ear.said).toEqual(["Connected · Iroh (relayed)"]);
  });

  it("says it at once where no move is due: Iroh chosen, or no direct transport both apps run", () => {
    for (const link of [linkView({ ...onIroh, transportAutomatic: false, preferredTransport: "iroh/1" }), linkView({ ...onIroh, availableTransports: ["iroh/1"] })]) {
      const { engine, unmount } = renderApp(<ChatConnection peerKey="peer" />);
      act(() => engine.update({ links: [onDht] }));
      act(() => engine.update({ links: [link] }));
      expect(document.querySelector(".sr-only[aria-live=polite]")).toHaveTextContent("Connected · Iroh (relayed)");
      unmount();
    }
  });
});

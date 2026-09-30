import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LiveAttempt } from "@ghostly/core";
import type { LinkView } from "@ghostly/browser/shared/types";
import { ChatConnection } from "../../components/ChatConnection";
import { liveAttemptText } from "../../lib/transportEvents";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: transport.wait, transport.indicator

describe("why a chat is not live (WISP 100)", () => {
  const text = (attempt: LiveAttempt | undefined, dialer?: "you" | "contact") => liveAttemptText(attempt, dialer, "Bea", () => "17:02");

  it("says what the dialling side tried, why each did not connect, and when it tries again", () => {
    expect(text({ at: 1, side: "dialled", retryAt: 2, failed: [
      { transport: "webrtc/1", error: "The offer was not answered" },
      { transport: "iroh/1", error: "The contact has no Iroh relay" },
    ] }, "you")).toEqual({ label: "Last attempt at 17:02", lines: [
      "WebRTC: The offer was not answered.", "Iroh: The contact has no Iroh relay.", "Trying again at about 17:02.",
    ] });
    // Nothing to try yet: why, instead of a list.
    expect(text({ at: 1, side: "dialled", failed: [], reason: "No transport both apps allow is available yet" }, "you")?.lines)
      .toEqual(["No transport both apps allow is available yet."]);
  });

  it("says on the answering side that the contact dials, and what of it reached this app", () => {
    expect(text({ at: 1, side: "answered", failed: [{ transport: "webrtc/1", error: "No connection came up" }] }, "contact")).toEqual({
      label: "Last attempt at 17:02", lines: ["Bea's app connects to this one: this app answers.", "Bea's last attempt reached this app and did not connect:", "WebRTC: No connection came up."],
    });
    expect(text(undefined, "contact")).toEqual({ label: "Not live yet", lines: ["Bea's app connects to this one: this app answers.", "No attempt of Bea's has reached this app yet."] });
  });

  it("says nothing on the dialling side before its first attempt", () => {
    expect(text(undefined, "you")).toBeUndefined();
    expect(text(undefined, undefined)).toBeUndefined();
  });
});

describe("the connection panel of a chat on the DHT", () => {
  const onDht: Partial<LinkView> = { textDelivery: "dht", dataLink: "idle", peerParticipationKey: "saved", peerNick: "Bea",
    pairing: { status: "connecting" } as LinkView["pairing"] };
  function panel(link: Partial<LinkView>) {
    const view = renderApp(<ChatConnection peerKey="peer" />);
    act(() => view.engine.update({ links: [linkView({ availableTransports: ["webrtc/1", "iroh/1"], ...onDht, ...link })] }));
    return view;
  }

  it("says under Details why it is not live, from this side's last attempt", () => {
    panel({ liveDialer: "you", liveAttempt: { at: Date.UTC(2026, 8, 25, 19, 58), side: "dialled", retryAt: Date.UTC(2026, 8, 25, 19, 59),
      failed: [{ transport: "webrtc/1", error: "The offer was not answered" }, { transport: "iroh/1", error: "The contact has no Iroh relay" }] } });
    expect(screen.getByTestId("connection-options")).toHaveAttribute("aria-label", "Connection options: On DHT · retrying live");
    const block = screen.getByTestId("connection-not-live");
    expect(screen.getByTestId("connection-details")).toContainElement(block);
    expect(block).toHaveAttribute("data-side", "dialled");
    expect(block).toHaveTextContent(/^Last attempt at /);
    expect(block).toHaveTextContent("WebRTC: The offer was not answered.");
    expect(block).toHaveTextContent("Iroh: The contact has no Iroh relay.");
    expect(block).toHaveTextContent(/Trying again at about /);
  });

  it("says on the side that answers that its contact dials, before anything reached it", () => {
    panel({ liveDialer: "contact" });
    expect(screen.getByTestId("connection-not-live")).toHaveTextContent("Not live yetBea's app connects to this one: this app answers.No attempt of Bea's has reached this app yet.");
  });

  it("says nothing of it while live, or in DHT only", () => {
    const attempt: LiveAttempt = { at: 1, side: "dialled", failed: [{ transport: "iroh/1", error: "x" }] };
    const live = panel({ textDelivery: "stream", dataLink: "open", pairing: { status: "ready", transport: "iroh/1" } as LinkView["pairing"], liveDialer: "you", liveAttempt: attempt });
    expect(screen.queryByTestId("connection-not-live")).toBeNull();
    live.unmount();
    panel({ deliveryMode: "dht", liveDialer: "contact" });
    expect(screen.queryByTestId("connection-not-live")).toBeNull();
  });
});

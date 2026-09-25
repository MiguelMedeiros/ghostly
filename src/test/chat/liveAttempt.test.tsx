import { describe, expect, it } from "vitest";
import type { LiveAttempt } from "@ghostly/core";
import { liveAttemptText } from "../../lib/transportEvents";

// covers: transport.wait

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

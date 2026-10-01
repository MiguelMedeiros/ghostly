import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import { MessageInput } from "../../components/MessageInput";
import { ConnectionHistory, TransportLine } from "../../components/TransportTimeline";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { formatListTime } from "../../lib/chatList";
import { clockTime, formatAt } from "../../lib/time";
import type { ChatMessage } from "../../lib/types";
import { renderApp } from "../render";

// covers: app.i18n

/**
 * Times and the composer speak the app's language, not the browser's: an Arabic interface on an English browser wrote
 * "AM 11:00" beside each message and "...Message" in the field.
 */
const AT = 1_700_000_000_000;
const message: ChatMessage = { id: "m1", text: "مرحبا", sender: "peer", timestamp: AT };
const arabicClock = new Intl.DateTimeFormat("ar", { hour: "2-digit", minute: "2-digit" }).format(AT);

afterEach(() => localStorage.clear());

describe("in Arabic", () => {
  it("a message's time is written the Arabic way", () => {
    expect(arabicClock).not.toBe(new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit" }).format(AT));
    renderApp(<MessageBubble message={message} peerPubKey="peer" />, { language: "ar" });
    expect(screen.getByText(arabicClock)).toBeInTheDocument();
  });

  it("the composer asks for a message in Arabic", () => {
    renderApp(<LockScreenProvider><MessageInput draftId="ar-draft" onSend={async () => null} /></LockScreenProvider>, { language: "ar" });
    expect(screen.getByPlaceholderText("رسالة…")).toBeInTheDocument();
  });

  it("the chat list's date and every clock follow the language given, the device's without one", () => {
    const week = 8 * 86_400_000;
    expect(formatListTime(AT, AT + week, "ar")).toBe(new Date(AT).toLocaleDateString("ar", { month: "short", day: "numeric" }));
    expect(clockTime(AT, "ar")).toBe(arabicClock);
    expect(clockTime(AT)).toBe(new Date(AT).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  });

  it("a transport line's details say since when the Arabic way", async () => {
    const { user } = renderApp(<TransportLine entry={{ id: "l1", at: AT, kind: "connected", transport: "webrtc/1" }} contact="Ana" />, { language: "ar" });
    await user.click(screen.getByTestId("transport-line").querySelector("button")!);
    const since = new Intl.DateTimeFormat("ar", { dateStyle: "medium", timeStyle: "medium" }).format(AT);
    expect(since).not.toBe(new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "medium" }).format(AT));
    expect(within(screen.getByTestId("transport-line-details")).getByText(since)).toBeInTheDocument();
  });

  it("the connection history's times are written the Arabic way", async () => {
    const now = Date.now(), older = AT;
    const { user } = renderApp(<ConnectionHistory events={[{ at: older, kind: "live", transport: "webrtc/1" }, { at: now, kind: "down", from: "webrtc/1" }]} contact="Ana" />, { language: "ar" });
    await user.click(screen.getByTestId("connection-history").querySelector("summary")!);
    const stamps = screen.getAllByTestId("connection-history-event").map(e => e.querySelector("time")!.textContent);
    expect(stamps).toEqual([
      new Intl.DateTimeFormat("ar", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(now),
      new Intl.DateTimeFormat("ar", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(older),
    ]);
  });

  it("formatAt follows the language given, the device's without one", () => {
    const options: Intl.DateTimeFormatOptions = { dateStyle: "short", timeStyle: "medium" };
    expect(formatAt(AT, options, "ar")).toBe(new Intl.DateTimeFormat("ar", options).format(AT));
    expect(formatAt(AT, { timeStyle: "medium" }, "ja")).toBe(new Intl.DateTimeFormat("ja", { timeStyle: "medium" }).format(AT));
    expect(formatAt(AT, options)).toBe(new Date(AT).toLocaleString([], options));
    expect(formatAt(Number.NaN, options, "ar")).toBe("Invalid Date");
  });
});

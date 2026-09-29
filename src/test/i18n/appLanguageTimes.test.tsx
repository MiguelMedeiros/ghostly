import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import { MessageInput } from "../../components/MessageInput";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { formatListTime } from "../../lib/chatList";
import { clockTime } from "../../lib/time";
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
});

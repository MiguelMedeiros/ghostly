import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIncomingCallNotice } from "../../hooks/useIncomingCallNotice";
import { loadSettings, saveSettings } from "../../lib/settings";

// covers: calls.ring-elsewhere

const notices = vi.hoisted(() => ({ show: vi.fn(async (_id: string, _body: string, _chat?: string) => {}) }));
vi.mock("../../lib/notifications", async (original) => ({ ...(await original<typeof import("../../lib/notifications")>()), showPrivateNotification: notices.show }));

let hidden = false;
let focused = true;

beforeEach(() => {
  hidden = false;
  focused = true;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => (hidden ? "hidden" : "visible"));
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  const settings = loadSettings();
  saveSettings({ ...settings, notifications: { ...settings.notifications, systemEnabled: true } });
  notices.show.mockClear();
});

afterEach(() => vi.restoreAllMocks());

const shown = () => notices.show.mock.calls.map(([, body, chat]) => ({ body, chat }));

describe("a call that rings while the app is out of sight", () => {
  it("is a system notification that opens its chat, when the tab is in the background", () => {
    hidden = true;
    focused = false;
    renderHook(() => useIncomingCallNotice(true, "chat-a", "Incoming call"));
    expect(shown()).toEqual([{ body: "Incoming call", chat: "chat-a" }]);
  });

  it("is one when the app goes out of sight while it still rings, and only once", () => {
    const { rerender } = renderHook(({ ringing }) => useIncomingCallNotice(ringing, "chat-a", "Incoming call"), { initialProps: { ringing: true } });
    expect(shown()).toEqual([]);
    focused = false;
    window.dispatchEvent(new Event("blur"));
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    rerender({ ringing: true });
    expect(shown()).toEqual([{ body: "Incoming call", chat: "chat-a" }]);
  });

  it("is none while the app is in front, once the ringing stopped, or with notifications off", () => {
    const { rerender } = renderHook(({ ringing }) => useIncomingCallNotice(ringing, "chat-a", "Incoming call"), { initialProps: { ringing: true } });
    rerender({ ringing: false });
    hidden = true;
    focused = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(shown()).toEqual([]);

    const settings = loadSettings();
    saveSettings({ ...settings, notifications: { ...settings.notifications, systemEnabled: false } });
    renderHook(() => useIncomingCallNotice(true, "chat-b", "Incoming call"));
    expect(shown()).toEqual([]);
  });
});

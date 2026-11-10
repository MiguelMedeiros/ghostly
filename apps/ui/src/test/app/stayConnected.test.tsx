import { act, fireEvent, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineState, GroupView, LinkView } from "@ghostly/browser/shared/types";
import { StayConnectedRow } from "../../components/settings/StayConnected";
import { StoppedInBackgroundBanner } from "../../components/StoppedInBackgroundBanner";
import { connectionNeed, dismissStoppedInBackground, TELL_AGAIN_MS, useStayConnected } from "../../lib/stayConnected";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: android.background.connected

/*
 * "Stay connected in the background" in the Android app: out of sight Android froze the app and every chat's and
 * group's link went down within seconds. While the switch is on (by default), the app unlocked and online with a chat
 * or a group, Rust's `connection_service` holds a foreground service with a quiet notification (ConnectionService.kt),
 * and a wake lock while a link is up.
 */

const tauri = vi.hoisted(() => ({
  killed: false,
  invoke: vi.fn(async (command: string, _args?: unknown): Promise<unknown> => {
    if (command === "connection_service") return { held: (_args as { on: boolean }).on, killed: tauri.killed };
    return undefined;
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, getVersion: async () => "0.4.0" }));

const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 8; wv) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36";
const told = () => tauri.invoke.mock.calls.filter(([command]) => command === "connection_service").map(([, args]) => args as { on: boolean; links: boolean });
const last = () => told()[told().length - 1];

function android(on: boolean) {
  if (on) (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(on ? ANDROID : "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36");
}

const link = (dataLink: LinkView["dataLink"]) => ({ id: `l-${dataLink}`, peerPubKeyZ32: "p", dataLink }) as LinkView;
const group = (edge?: "open" | "waiting", status: GroupView["status"] = "active" as GroupView["status"]) =>
  ({ id: "g", status, members: [{ key: "me" }, { key: "m", edge: edge && { linkId: "e", state: edge, lastSeenAt: 0 } }] }) as unknown as GroupView;
const state = (patch: Partial<EngineState>) => ({ settings: { online: true }, links: [], groups: [], ...patch }) as unknown as EngineState;

beforeEach(() => {
  tauri.killed = false;
  tauri.invoke.mockClear();
});
afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  localStorage.clear();
  dismissStoppedInBackground();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("when the app stays connected", () => {
  it("online with a chat or a group; a wake lock only while a link or a member's edge is open", () => {
    expect(connectionNeed(null)).toEqual({ wanted: false, links: false });
    // Nobody to stay connected to: no notification for nothing.
    expect(connectionNeed(state({}))).toEqual({ wanted: false, links: false });
    expect(connectionNeed(state({ links: [link("idle")] }))).toEqual({ wanted: true, links: false });
    expect(connectionNeed(state({ links: [link("idle"), link("open")] }))).toEqual({ wanted: true, links: true });
    expect(connectionNeed(state({ groups: [group("waiting")] }))).toEqual({ wanted: true, links: false });
    expect(connectionNeed(state({ groups: [group("open")] }))).toEqual({ wanted: true, links: true });
    // An invitation only, or a group lost: not a group to stay in.
    expect(connectionNeed(state({ groups: [{ ...group("open"), status: undefined }] })).wanted).toBe(false);
    expect(connectionNeed(state({ groups: [group("open", "lost")] })).wanted).toBe(false);
    // Ghostly's own switch off, or a limited start: nothing goes out, nothing to hold.
    expect(connectionNeed(state({ settings: { online: false } as EngineState["settings"], links: [link("open")] }))).toEqual({ wanted: false, links: false });
    expect(connectionNeed(state({ limited: true, links: [link("open")] }))).toEqual({ wanted: false, links: false });
  });
});

describe("the Android connection service", () => {
  it("is held by default with a chat, told of links as they come and go, and let go with no chat or when the profile closes", async () => {
    android(true);
    const { unmount } = renderHook(() => useStayConnected());
    await waitFor(() => expect(last()).toEqual({ on: false, links: false }));

    act(() => fakeEngine.update({ links: [link("idle")] }));
    await waitFor(() => expect(last()).toEqual({ on: true, links: false }));
    act(() => fakeEngine.update({ links: [link("open")] }));
    await waitFor(() => expect(last()).toEqual({ on: true, links: true }));
    act(() => fakeEngine.update({ links: [link("idle")] }));
    await waitFor(() => expect(last()).toEqual({ on: true, links: false }));

    act(() => fakeEngine.update({ links: [] }));
    await waitFor(() => expect(last()).toEqual({ on: false, links: false }));
    act(() => fakeEngine.update({ links: [link("open")] }));
    await waitFor(() => expect(last()).toEqual({ on: true, links: true }));
    unmount();
    expect(last()).toEqual({ on: false, links: false });
  });

  it("lets go while Ghostly is offline", async () => {
    android(true);
    fakeEngine.update({ links: [link("open")] });
    renderHook(() => useStayConnected());
    await waitFor(() => expect(last()).toEqual({ on: true, links: true }));
    act(() => fakeEngine.update({ settings: { ...fakeEngine.state!.settings, online: false } }));
    await waitFor(() => expect(last()).toEqual({ on: false, links: false }));
  });

  it("is told again every few minutes while on, so its wake lock's lease never runs out under a live page", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    android(true);
    fakeEngine.update({ links: [link("open")] });
    const { unmount } = renderHook(() => useStayConnected());
    await waitFor(() => expect(last()).toEqual({ on: true, links: true }));
    const before = told().length;
    act(() => { vi.advanceTimersByTime(TELL_AGAIN_MS * 2); });
    expect(told().length - before).toBe(2);
    unmount();
    // Off: nothing told again.
    const after = told().length;
    act(() => { vi.advanceTimersByTime(TELL_AGAIN_MS * 2); });
    expect(told().length).toBe(after);
  });

  it("holds nothing with the switch off, and is let go when it is turned off", async () => {
    android(true);
    fakeEngine.update({ links: [link("open")] });
    renderApp(<StayConnectedRow />);
    renderHook(() => useStayConnected());
    const toggle = await screen.findByTestId("settings-stay-connected");
    // On by default, with what it costs.
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("settings-stay-connected-hint")).toHaveTextContent("Uses more battery");
    await waitFor(() => expect(last()).toEqual({ on: true, links: true }));

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(localStorage.getItem("ghostly_stay_connected")).toBe("0");
    await waitFor(() => expect(last()).toEqual({ on: false, links: false }));

    fireEvent.click(toggle);
    expect(localStorage.getItem("ghostly_stay_connected")).toBeNull();
    await waitFor(() => expect(last()).toEqual({ on: true, links: true }));
  });

  it("once the system ended the app under it, says so above the list and in Settings, with the app's settings a tap away", async () => {
    android(true);
    tauri.killed = true;
    fakeEngine.update({ links: [link("open")] });
    renderApp(<><StoppedInBackgroundBanner /><StayConnectedRow /></>);
    // Nothing before the service said so: never on a first run.
    expect(screen.queryByTestId("stopped-in-background-banner")).toBeNull();
    renderHook(() => useStayConnected());
    const banner = await screen.findByTestId("stopped-in-background-banner");
    expect(banner).toHaveTextContent("Android stopped Ghostly in the background");
    expect(banner).toHaveTextContent("Unrestricted");
    expect(screen.getByTestId("settings-stay-connected-hint")).toHaveTextContent("Unrestricted");

    fireEvent.click(screen.getByTestId("stopped-in-background-settings"));
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("open_app_settings"));
    expect(screen.queryByTestId("stopped-in-background-banner")).toBeNull();
    expect(screen.queryByTestId("settings-stay-connected-open-settings")).toBeNull();
  });

  it("holds nothing outside the Android app", async () => {
    android(false);
    fakeEngine.update({ links: [link("open")] });
    const { unmount } = renderHook(() => useStayConnected());
    await new Promise((done) => setTimeout(done, 20));
    unmount();
    expect(told()).toEqual([]);
  });
});

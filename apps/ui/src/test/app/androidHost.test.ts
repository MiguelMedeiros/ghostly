import { afterEach, describe, expect, it, vi } from "vitest";
import { RTC_CONFIG } from "@ghostly/core";
import { cssColorHex, followAppVisibility, followSystemBars, leaveOutPublicStun, takeIncomingShares, withoutPublicStun } from "../../desktop/android";
import { incomingShare, resetIncomingShare } from "../../lib/incomingShare";
import { androidApp, touchOnly } from "../../lib/touchOnly";

// covers: app.android.share-target, app.android.test-network

/*
 * The Android app's page side (apps/ui/src/desktop/android.ts): the system bars take the page's background and
 * follow the theme; a share from another app reaches the Share to… picker with its files read whole; and the app is
 * touch only whatever the pointer query says.
 */

const agent = navigator.userAgent;
const setAgent = (value: string) => Object.defineProperty(navigator, "userAgent", { value, configurable: true });

afterEach(() => {
  resetIncomingShare();
  setAgent(agent);
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  document.documentElement.removeAttribute("data-theme");
  document.body.style.backgroundColor = "";
  location.hash = "";
});

describe("the system bars", () => {
  it("read the page's background colour as #rrggbb, and nothing see-through", () => {
    expect(cssColorHex("rgb(11, 20, 26)")).toBe("#0b141a");
    expect(cssColorHex("rgba(255, 255, 255, 1)")).toBe("#ffffff");
    expect(cssColorHex("rgb(0 128 105)")).toBe("#008069");
    expect(cssColorHex("rgba(0, 0, 0, 0)")).toBeUndefined();
    expect(cssColorHex("transparent")).toBeUndefined();
    expect(cssColorHex("#0b141a")).toBeUndefined();
  });

  it("take the page's background now and each time the theme changes, once per change", async () => {
    const invoke = vi.fn(async (_command: string, _args?: Record<string, unknown>) => undefined);
    const lastCall = () => invoke.mock.calls[invoke.mock.calls.length - 1];
    document.documentElement.setAttribute("data-theme", "dark");
    document.body.style.backgroundColor = "rgb(11, 20, 26)";
    const stop = followSystemBars(invoke as never);
    expect(invoke.mock.calls).toEqual([["system_bars", { color: "#0b141a", dark: true }]]);

    document.body.style.backgroundColor = "rgb(255, 255, 255)";
    document.documentElement.setAttribute("data-theme", "light");
    await vi.waitFor(() => expect(lastCall()).toEqual(["system_bars", { color: "#ffffff", dark: false }]));
    // The same colours again: nothing new to send.
    document.documentElement.setAttribute("data-color-theme", "classic");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(invoke).toHaveBeenCalledTimes(2);

    stop();
    document.documentElement.setAttribute("data-theme", "dark");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(invoke).toHaveBeenCalledTimes(2);
    document.documentElement.removeAttribute("data-color-theme");
  });
});

describe("a share from another app", () => {
  it("is taken at start, its files read whole by token, and opens the Share to… picker", async () => {
    const bytes = new TextEncoder().encode("hello from another app");
    const shares = [{
      title: "A note",
      text: "Look https://example.com",
      files: [
        { token: "paste-1", name: "note.txt", size: bytes.length, mime: "text/plain" },
        { token: "paste-2", name: "huge.bin", size: 2 ** 40, mime: null },
      ],
    }];
    const reads: unknown[] = [];
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "incoming_share_take") return shares.shift() ?? null;
      if (command === "read_pasted_bytes") {
        reads.push(args);
        const offset = args!.offset as number;
        // As Android's IPC answers: a JSON array of the bytes.
        return Array.from(bytes.slice(offset, offset + 8));
      }
      throw new Error(command);
    });
    let arrived: () => void = () => {};
    const listen = vi.fn(async (_event: string, handler: () => void) => { arrived = handler; });
    takeIncomingShares(invoke as never, listen);
    await vi.waitFor(() => expect(incomingShare()).not.toBeNull());

    const share = incomingShare()!;
    expect([share.title, share.text, share.url]).toEqual(["A note", "Look https://example.com", ""]);
    // The file too large to paste is left out, and never read.
    expect(share.files.map((file) => [file.name, file.type, file.size])).toEqual([["note.txt", "text/plain", bytes.length]]);
    expect(new TextDecoder().decode(await share.files[0]!.arrayBuffer())).toBe("hello from another app");
    expect(reads.every((read) => (read as { token: string }).token === "paste-1")).toBe(true);
    expect(location.hash).toBe("#/shared");
    expect(listen).toHaveBeenCalledWith("incoming-share", expect.any(Function));

    // Rust says another arrived while the app runs: it is taken then.
    shares.push({ title: "", text: "second", files: [] });
    arrived();
    await vi.waitFor(() => expect(incomingShare()?.text).toBe("second"));
  });

  it("taken later wins over a big one still being read, and an emptied late one clears nothing", async () => {
    const shares: unknown[] = [{ title: "", text: "", files: [{ token: "video", name: "VID_1.mp4", size: 4, mime: "video/mp4" }] }];
    let videoRead: (bytes: number[]) => void = () => {};
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "incoming_share_take") return shares.shift() ?? null;
      if (command === "read_pasted_bytes") {
        if (args!.token === "video") return new Promise<number[]>((resolve) => { videoRead = resolve; });
        return args!.offset === 0 ? [1, 2, 3] : [];
      }
      throw new Error(command);
    });
    let arrived: () => void = () => {};
    takeIncomingShares(invoke as never, async (_event, handler) => { arrived = handler; });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("read_pasted_bytes", expect.objectContaining({ token: "video" })));

    // The person changed their mind: a photo, read at once.
    shares.push({ title: "", text: "", files: [{ token: "photo", name: "IMG_1.jpg", size: 3, mime: "image/jpeg" }] });
    arrived();
    await vi.waitFor(() => expect(incomingShare()?.files.map((file) => file.name)).toEqual(["IMG_1.jpg"]));

    // The video's read ends after it: the photo stays.
    videoRead([1, 2, 3, 4]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(incomingShare()?.files.map((file) => file.name)).toEqual(["IMG_1.jpg"]);

    // An older share that reached Rust last, its file gone: nothing in it, so the photo still waits.
    shares.push({ title: "", text: "", files: [] });
    arrived();
    await vi.waitFor(() => expect(shares).toHaveLength(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(incomingShare()?.files.map((file) => file.name)).toEqual(["IMG_1.jpg"]);
  });

  it("lets its copies go once read, the ones too large to paste and an overtaken share's too", async () => {
    const shares: unknown[] = [{ title: "", text: "", files: [{ token: "video", name: "VID_1.mp4", size: 4, mime: "video/mp4" }] }];
    let videoRead: (bytes: number[]) => void = () => {};
    const done: unknown[] = [];
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "incoming_share_take") return shares.shift() ?? null;
      if (command === "incoming_share_done") return void done.push(args!.tokens);
      if (command === "read_pasted_bytes") {
        if (args!.token === "video") return new Promise<number[]>((resolve) => { videoRead = resolve; });
        return args!.offset === 0 ? [1, 2, 3] : [];
      }
      throw new Error(command);
    });
    let arrived: () => void = () => {};
    takeIncomingShares(invoke as never, async (_event, handler) => { arrived = handler; });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("read_pasted_bytes", expect.objectContaining({ token: "video" })));
    // Still being read: its copy stays.
    expect(done).toEqual([]);

    shares.push({
      title: "",
      text: "",
      files: [{ token: "photo", name: "IMG_1.jpg", size: 3, mime: "image/jpeg" }, { token: "huge", name: "huge.bin", size: 2 ** 40, mime: null }],
    });
    arrived();
    await vi.waitFor(() => expect(incomingShare()?.files.map((file) => file.name)).toEqual(["IMG_1.jpg"]));
    expect(done).toEqual([["photo", "huge"]]);

    // The overtaken video, read in the end: its copy goes too.
    videoRead([1, 2, 3, 4]);
    await vi.waitFor(() => expect(done).toEqual([["photo", "huge"], ["video"]]));
  });

  it("is nothing when none waits", async () => {
    const invoke = vi.fn(async () => null);
    takeIncomingShares(invoke as never, async () => undefined);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("incoming_share_take"));
    expect(incomingShare()).toBeNull();
    expect(location.hash).toBe("");
  });
});

describe("touch only", () => {
  it("is always so in the Android app, and only there whatever the agent says", () => {
    setAgent("Mozilla/5.0 (Linux; Android 15; sdk_gphone64_x86_64) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36");
    expect(androidApp()).toBe(false);
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    expect(androidApp()).toBe(true);
    expect(touchOnly()).toBe(true);
    setAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15");
    expect(androidApp()).toBe(false);
  });
});

describe("the app in the background", () => {
  it("reads as a hidden, unfocused page while the activity is stopped, and visible again when it comes back", async () => {
    const doc = document.implementation.createHTMLDocument("app");
    doc.hasFocus = () => true;
    let heard: ((event: { payload: string }) => void) | undefined;
    const listen = vi.fn(async (event: string, handler: (event: { payload: string }) => void) => { if (event === "app-visibility") heard = handler; return () => {}; });
    const changes: string[] = [];
    doc.addEventListener("visibilitychange", () => changes.push(doc.visibilityState));
    followAppVisibility(listen as never, doc);
    await vi.waitFor(() => expect(heard).toBeDefined());
    expect([doc.visibilityState, doc.hidden, doc.hasFocus()]).toEqual(["visible", false, true]);
    heard!({ payload: "hidden" });
    expect([doc.visibilityState, doc.hidden, doc.hasFocus()]).toEqual(["hidden", true, false]);
    heard!({ payload: "hidden" });
    heard!({ payload: "visible" });
    expect([doc.visibilityState, doc.hidden, doc.hasFocus()]).toEqual(["visible", false, true]);
    expect(changes).toEqual(["hidden", "visible"]);
  });
});

describe("a test start's WebRTC (GHOSTLY_STUN=0)", () => {
  /** A stand-in RTCPeerConnection that keeps the configuration it was made with. */
  class Recorded { constructor(readonly config?: RTCConfiguration) {} }
  const profileTurn = { urls: ["turn:turn.lan:3478"], username: "u", credential: "p" };
  const made = () => ({ iceServers: [...(RTC_CONFIG.iceServers ?? []), profileTurn] });
  const urls = (config?: RTCConfiguration) => (config?.iceServers ?? []).flatMap((server) => [server.urls].flat());

  it("leaves the apps' public STUN servers out of every new connection, and keeps the profile's TURN", async () => {
    const scope = { RTCPeerConnection: Recorded as unknown as typeof RTCPeerConnection };
    const invoke = vi.fn(async () => ({ stun: false })) as never;
    expect(await leaveOutPublicStun(invoke, scope)).toBe(true);
    const connection = new scope.RTCPeerConnection(made()) as unknown as Recorded;
    expect(connection).toBeInstanceOf(Recorded);
    expect(urls(connection.config).some((url) => /google\.com/.test(url))).toBe(false);
    expect(connection.config?.iceServers).toEqual([profileTurn]);
    expect(withoutPublicStun(undefined)).toBeUndefined();
  });

  it("wraps nothing when the public STUN servers are allowed", async () => {
    const scope = { RTCPeerConnection: Recorded as unknown as typeof RTCPeerConnection };
    const invoke = vi.fn(async (command: string) => (command === "test_network" ? { stun: true } : undefined)) as never;
    expect(await leaveOutPublicStun(invoke, scope)).toBe(false);
    expect(scope.RTCPeerConnection).toBe(Recorded);
    const connection = new scope.RTCPeerConnection(made()) as unknown as Recorded;
    expect(urls(connection.config)).toContain("stun:stun.l.google.com:19302");
  });
});

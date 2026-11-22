import { act, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageInput } from "../../components/MessageInput";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { renderApp } from "../render";

// covers: app.composer.attach

/*
 * The composer's Camera in the Android app opens the phone's camera from a file input. Android's CAMERA refused
 * reached that input as a plain cancel: Camera did nothing, and once Android stopped asking it did nothing for good,
 * with no word of why. The app now hears it (Rust's `camera-refused`, "refused" or "blocked") and says so, with
 * Android's settings once only they can allow it.
 */

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => undefined),
  /** The page's `camera-refused` listeners. */
  refused: new Set<(event: { payload: string }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
  listen: async (name: string, handler: (event: { payload: string }) => void) => {
    if (name !== "camera-refused") return () => {};
    tauri.refused.add(handler);
    return () => { tauri.refused.delete(handler); };
  },
  getVersion: async () => "0.4.0",
}));

const onSend = vi.fn<(text: string) => Promise<string | null>>();
const onSendFile = vi.fn<(file: File) => Promise<string | null>>();

function composer() {
  return renderApp(<LockScreenProvider><MessageInput onSend={onSend} onSendFile={onSendFile} /></LockScreenProvider>);
}

/** Android says the camera was refused: "refused" (it asks again next time) or "blocked" (it no longer asks). */
const android = (payload: "refused" | "blocked") => act(() => { tauri.refused.forEach((heard) => heard({ payload })); });

/** + → Camera, on the phone: the camera's file input is clicked (Android then asks for CAMERA). */
async function tapCamera(user: ReturnType<typeof composer>["user"]) {
  const input = screen.getByTestId<HTMLInputElement>("camera-input");
  const click = vi.spyOn(input, "click").mockImplementation(() => {});
  await user.click(screen.getByTestId("composer-more"));
  await user.click(await screen.findByTestId("composer-camera"));
  expect(click).toHaveBeenCalledOnce();
}

beforeEach(() => {
  onSend.mockReset().mockResolvedValue(null);
  onSendFile.mockReset().mockResolvedValue(null);
  tauri.invoke.mockClear();
  (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Linux; Android 15; Pixel 8; wv) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36");
  const real = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation((query) => {
    const list = real(query);
    if (query === "(pointer: coarse)") Object.defineProperty(list, "matches", { value: true });
    return list;
  });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
    getUserMedia: vi.fn(),
    enumerateDevices: vi.fn(async () => [{ kind: "videoinput", deviceId: "", label: "", groupId: "" }]),
  } });
});
afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  Reflect.deleteProperty(navigator, "mediaDevices");
  vi.restoreAllMocks();
});

describe("the phone's Camera refused by Android", () => {
  it("once Android no longer asks: the composer says the camera is blocked, and Open settings opens the app's page in Android's settings", async () => {
    const { user } = composer();
    await tapCamera(user);
    await android("blocked");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Camera blocked. Allow the camera in Android's settings for Ghostly.");
    await user.click(within(alert).getByRole("button", { name: "Open settings" }));
    expect(tauri.invoke).toHaveBeenCalledWith("open_app_settings");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("refused while Android still asks: the composer says so, and to tap Camera again", async () => {
    const { user } = composer();
    await tapCamera(user);
    await android("refused");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("No access to the camera. Tap Camera again and allow it.");
    expect(within(alert).queryByRole("button", { name: "Open settings" })).not.toBeInTheDocument();
  });

  it("a refusal for a Camera this composer did not open says nothing here", async () => {
    composer();
    await vi.waitFor(() => expect(tauri.refused.size).toBe(1));
    await android("blocked");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

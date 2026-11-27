// covers: invite.qr.camera
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { JoinDialog } from "../../components/JoinDialog";
import { renderApp } from "../render";

/*
 * Join's Scan (apps/ui/src/components/JoinDialog.tsx) with the camera refused in the Android app. Android asks for the
 * camera there, and once it stops asking ("Don't allow" twice) only its settings for Ghostly allow it again: the
 * refusal said only "Camera unavailable", with no way to those settings, as a call, the composer's Camera and a voice
 * message offer. Join and a device's "Add this device" both scan here.
 */

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

const android = vi.hoisted(() => ({ on: true, settings: vi.fn(async () => {}) }));
vi.mock("../../desktop/androidMediaDenied", async (actual) => ({
  ...await actual<typeof import("../../desktop/androidMediaDenied")>(),
  mediaDeniedOnAndroid: () => android.on,
}));
vi.mock("../../desktop/androidCameraRefusal", async (actual) => ({
  ...await actual<typeof import("../../desktop/androidCameraRefusal")>(),
  openAppSettings: android.settings,
}));

/** The camera's refusal as the WebView gives it, or no camera at all. */
function camera(name: "NotAllowedError" | "NotFoundError") {
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => { throw new DOMException("refused", name); } } });
}

describe("Join's Scan with the camera refused", () => {
  beforeEach(() => { android.on = true; android.settings.mockClear(); });
  afterEach(() => { delete (navigator as unknown as Record<string, unknown>).mediaDevices; });

  it.each([
    ["Join", {}, "Camera unavailable. Paste an invite or open an image."],
    ["Add this device", { onDevice: async () => {} }, "Camera unavailable. Paste the code from your other device, or open an image."],
  ])("in the Android app (%s), says it is blocked and opens Android's settings", async (_, props, unavailable) => {
    camera("NotAllowedError");
    const { user } = renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} {...props} />);
    await user.click(screen.getByRole("button", { name: "Scan QR", hidden: true }));
    expect(await screen.findByText("Camera blocked. Allow the camera in Android's settings for Ghostly.")).toBeTruthy();
    expect(screen.queryByText(unavailable)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open settings", hidden: true }));
    expect(android.settings).toHaveBeenCalledTimes(1);
    // Paste and the field are still there, the other ways in.
    expect(screen.getByRole("textbox", { hidden: true })).toBeTruthy();
  });

  it("in the Android app, a missing camera is still unavailable, with no settings to open", async () => {
    camera("NotFoundError");
    const { user } = renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Scan QR", hidden: true }));
    expect(await screen.findByText("Camera unavailable. Paste an invite or open an image.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open settings", hidden: true })).toBeNull();
  });

  it("outside the Android app, a refusal is unavailable as before", async () => {
    android.on = false;
    camera("NotAllowedError");
    const { user } = renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Scan QR", hidden: true }));
    expect(await screen.findByText("Camera unavailable. Paste an invite or open an image.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open settings", hidden: true })).toBeNull();
  });

  it("a new Scan takes the blocked line and its button away", async () => {
    camera("NotAllowedError");
    const { user } = renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Scan QR", hidden: true }));
    await screen.findByRole("button", { name: "Open settings", hidden: true });
    camera("NotFoundError");
    await user.click(screen.getByRole("button", { name: "Scan QR", hidden: true }));
    expect(await screen.findByText("Camera unavailable. Paste an invite or open an image.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open settings", hidden: true })).toBeNull();
  });
});

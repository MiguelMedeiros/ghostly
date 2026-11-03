import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { JoinDialog } from "../../components/JoinDialog";
import { renderApp } from "../render";
// covers: invite.qr.camera

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/**
 * Join's Scan and the camera's Cancel take each other's place (apps/ui/src/components/JoinDialog.tsx): the key that
 * pressed one lands on the other, as on a wallet's Send (SendScan), never on the page behind the dialog.
 */
describe("Join's Scan and Cancel by keyboard", () => {
  it("Scan hands the focus to the camera's Cancel while the camera starts, and Cancel back to Scan", async () => {
    // A camera that is still being asked for: Join shows Cancel in place of Scan meanwhile.
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia: vi.fn(() => new Promise(() => {})) } });
    const { user } = renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} />);
    screen.getByRole("button", { name: "Scan QR", hidden: true }).focus();
    await user.keyboard("{Enter}");
    const cancel = await screen.findByRole("button", { name: "Cancel", hidden: true });
    await waitFor(() => expect(cancel).toHaveFocus());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Scan QR", hidden: true })).toHaveFocus());
  });

  it("with the camera on, Cancel gives the focus back to Scan", async () => {
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) } });
    vi.spyOn(HTMLMediaElement.prototype, "srcObject", "set").mockImplementation(() => {});
    // The preview never plays: the decoder is not reached, the camera stays on until Cancel.
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => new Promise(() => {}));
    const { user } = renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} />);
    screen.getByRole("button", { name: "Scan QR", hidden: true }).focus();
    await user.keyboard("{Enter}");
    const cancel = await screen.findByRole("button", { name: "Cancel", hidden: true });
    await waitFor(() => expect(cancel).toHaveFocus());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Scan QR", hidden: true })).toHaveFocus());
    expect(track.stop).toHaveBeenCalled();
  });
});

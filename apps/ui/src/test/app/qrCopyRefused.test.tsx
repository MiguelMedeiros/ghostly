import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { QRCodeDisplay } from "../../components/QRCode";
import { renderApp } from "../render";
// covers: devices.enroll, invite.code

const link = "https://ghostly.tools/#device/ghostly1zexample";

/** Both ways of copying are refused: the clipboard (a permission, a page not focused) and the older route. */
function refuseCopy() {
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new DOMException("Write permission denied.", "NotAllowedError"));
  Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
}

afterEach(() => { vi.restoreAllMocks(); Reflect.deleteProperty(document, "execCommand"); Reflect.deleteProperty(navigator, "share"); });

describe("Copy refused under a QR code", () => {
  it("leaves the link on screen to select and copy by hand, and speaks of no Share that is not there", async () => {
    Reflect.deleteProperty(navigator, "share");
    const { user } = renderApp(<QRCodeDisplay value={link} copyLabel="Copy link" />);
    refuseCopy();
    // Nothing of the link shows until Copy fails: the QR code is the way in.
    expect(screen.queryByRole("textbox")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not copy. Select the link below and copy it.");
    expect(screen.getByRole("alert")).not.toHaveTextContent(/share|invite/i);
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    const field = screen.getByRole("textbox", { name: "Link" });
    expect(field).toHaveValue(link);
    expect(field).toHaveAttribute("readonly");
    expect(field).toHaveAttribute("dir", "ltr");
    // Never Copied, since nothing was copied.
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
  });

  it("says share only where Share is there", async () => {
    Object.defineProperty(navigator, "share", { configurable: true, value: () => Promise.resolve() });
    const { user } = renderApp(<QRCodeDisplay value={link} copyLabel="Copy link" />);
    refuseCopy();
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not copy. Select the link below or share it.");
    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Link" })).toHaveValue(link);
  });

  it("a copy that worked shows no field", async () => {
    const { user } = renderApp(<QRCodeDisplay value={link} copyLabel="Copy link" />);
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(await screen.findByRole("button", { name: "Copied!" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

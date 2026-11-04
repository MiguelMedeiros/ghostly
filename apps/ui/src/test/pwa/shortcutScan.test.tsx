import { screen, waitFor } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { listSessions } from "../../lib/storage";
import { renderApp } from "../render";

// covers: app.pwa.shortcuts

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

function Where() { return <p data-testid="where">{useLocation().pathname}</p>; }
const openAt = (route: string) => renderApp(<UpdateProvider><Sidebar /><Routes><Route path="*" element={<Where />} /></Routes></UpdateProvider>, { route });

// A camera that would start: a press is what turns it on.
const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop() {} }] }));
beforeEach(() => { getUserMedia.mockClear(); vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia } }); });
afterEach(() => { vi.unstubAllGlobals(); });

/** Any site can send the browser to `#/scan`: the installed app's Scan invite shortcut opens Join, and a press starts the camera. */
it("`#/scan` opens Join with Scan focused and starts no camera until it is pressed", async () => {
  const { user } = openAt("/scan");
  expect(await screen.findByRole("heading", { name: "Join a chat or group", hidden: true })).toBeInTheDocument();
  // Long enough for a camera started on opening to have been asked for.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(getUserMedia).not.toHaveBeenCalled();
  const scan = screen.getByRole("button", { name: "Scan QR", hidden: true });
  await waitFor(() => expect(scan).toHaveFocus());
  expect(screen.getByTestId("where")).toHaveTextContent(/^\/$/);
  expect(listSessions()).toEqual([]);

  await user.keyboard("{Enter}");
  await waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
});

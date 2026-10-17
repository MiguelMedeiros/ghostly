import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { JoinDialog } from "../../components/JoinDialog";
import { renderApp } from "../render";
// covers: invite.qr.image

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

/**
 * The QR decoder's chunk does not load, and keeps not loading: Chromium keeps a failed import for as long as the page
 * lives, however good the connection is again.
 */
vi.mock("jsqr", () => { throw new TypeError("Failed to fetch dynamically imported module"); });

const png = () => new File([new Uint8Array([137, 80, 78, 71])], "Screenshot.png", { type: "image/png" });
const paste = (files: File[]) => ({ files, types: ["Files"], items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })), getData: () => "" });
const pastePicture = () => fireEvent.paste(screen.getByRole("dialog", { hidden: true }), { clipboardData: paste([png()]) });

beforeEach(() => { vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 400, height: 400, close() {} }))); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("once the QR reader failed again, Join says to reload, with Reload, also when opened again; Reload goes only into a page the server answers for", async () => {
  const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
  let reachable = false;
  const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(() => (reachable ? Promise.resolve(new Response(null, { status: 200 })) : Promise.reject(new TypeError("Failed to fetch"))));
  const { unmount } = renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} />);

  // The first time, trying again may bring it (Firefox and Safari ask the server again).
  pastePicture();
  expect(await screen.findByRole("alert")).toHaveTextContent("The QR reader did not load. Check your connection, then try again.");
  expect(screen.queryByRole("button", { name: "Reload" })).not.toBeInTheDocument();

  // Tried again, as the notice said: it failed again, so the next step is a reload.
  pastePicture();
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The QR reader still did not load. Reload Ghostly to load it."));
  const button = screen.getByRole("button", { name: "Reload" });

  // No connection: a reload would leave the browser's own error page, so the app stays, and says why.
  fireEvent.click(button);
  await waitFor(() => expect(fetched).toHaveBeenCalledWith(location.pathname, { method: "HEAD", cache: "no-store" }));
  await waitFor(() => expect(button).not.toHaveAttribute("aria-disabled"));
  expect(reload).not.toHaveBeenCalled();
  expect(screen.getByRole("status")).toHaveTextContent("Can't reach Ghostly's server. Check your connection, then reload.");

  // Join closed and opened again: the reader is still the failed one.
  unmount();
  renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} />);
  pastePicture();
  expect(await screen.findByRole("alert")).toHaveTextContent("The QR reader still did not load. Reload Ghostly to load it.");
  reachable = true;
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(reload).toHaveBeenCalledOnce());
});

it("Reload goes with the reader's notice only, not with a later one", async () => {
  renderApp(<JoinDialog onJoin={() => {}} onClose={() => {}} />);
  pastePicture();
  expect(await screen.findByRole("alert")).toHaveTextContent("The QR reader still did not load.");
  expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  // A file that is not a picture, dropped: its own notice, no Reload.
  const file = new File(["x"], "notes.txt", { type: "text/plain" });
  fireEvent.drop(screen.getByRole("dialog", { hidden: true }), { dataTransfer: { files: [file], types: ["Files"], items: [{ kind: "file", type: file.type, getAsFile: () => file }] } });
  await waitFor(() => expect(screen.getByRole("alert")).not.toHaveTextContent("QR reader"));
  expect(screen.queryByRole("button", { name: "Reload" })).not.toBeInTheDocument();
});

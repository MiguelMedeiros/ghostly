import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import { servicesPlatform } from "../../lib/platform";
import type { ChatMessage } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// The converter's file did not load (a deploy replaced it under a tab left open, offline before the worker kept it):
// its import rejects with the browser's own English.
const browserWords = "Failed to fetch dynamically imported module: https://ghostly.example/assets/voiceMp3-abc123.js";
vi.mock("../../lib/voiceMp3", () => { throw new TypeError(browserWords); });

// covers: files.download

const voice: ChatMessage = {
  id: "m1", text: "🎤 Voice message (0:03)", sender: "peer", timestamp: new Date(2026, 8, 27, 14, 1, 30).getTime(),
  file: { id: "chat1-in-voice", name: "Voice message.webm", size: 4, mime: "audio/webm", voice: { duration: 3_000, peaks: [] } },
};

let clicked = 0;

beforeEach(() => {
  clicked = 0;
  vi.spyOn(servicesPlatform!, "getFile").mockImplementation(async () => new Blob(["opus"], { type: "audio/webm" }));
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => { clicked++; });
  URL.createObjectURL = vi.fn(() => "blob:ghostly/voice");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => vi.restoreAllMocks());

it("says a converter that did not load as such, not as a folder that refused the save, and without the browser's English", async () => {
  fakeEngine.update({ links: [linkView({ id: "chat1" })], transfers: {} });
  const { user } = renderApp(<MessageBubble message={voice} peerPubKey="peer" onDelete={() => {}} />);
  await user.click(screen.getByTestId("message-options"));
  await user.click(screen.getByTestId("message-download-mp3"));
  const item = screen.getByTestId("message-download-mp3");
  await waitFor(() => expect(item).toHaveAttribute("data-download-state", "unloaded"));
  expect(item).toHaveTextContent("Part of Ghostly did not load.");
  expect(item).not.toHaveTextContent("Try another folder");
  expect(item).toHaveAttribute("title", "Part of Ghostly did not load.\nCheck your connection, then try again. If it still fails, reload Ghostly.");
  expect(item.outerHTML).not.toContain("dynamically imported");
  // It can be tried again once the connection is back.
  expect(item).toBeEnabled();
  expect(clicked).toBe(0);
});

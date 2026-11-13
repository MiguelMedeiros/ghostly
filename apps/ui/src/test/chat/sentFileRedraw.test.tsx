import { act, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import type { FileTransferState } from "../../lib/platform";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: files.large.offer

/**
 * A file of mine on its way: its own part (FileBubble) shows how far it got, at every step of the engine's progress,
 * up to 20 a second. The rest of its message (its mark, its reactions, its menu) reads only whether the file failed,
 * so it is not drawn again at each step.
 */

const drawn = vi.hoisted(() => ({ views: 0 }));
vi.mock("../../contexts/MemberColorsContext", async (original) => {
  const actual = await original<typeof import("../../contexts/MemberColorsContext")>();
  // MessageBubbleView's own hook: one call per draw of the message around the file.
  return { ...actual, useMemberText: () => { drawn.views++; return actual.useMemberText(); } };
});

const ID = "chat1-out-abc";
const GB = 1024 ** 3;
const moving = (transferred: number): FileTransferState => ({ state: "transferring", direction: "out", transferred, size: 4 * GB });
const message = { id: "m1", text: "", sender: "me", timestamp: Date.now() - 60_000, status: "sent", file: { id: ID, name: "movie.mkv", size: 4 * GB, mime: "video/x-matroska" } } as never;

beforeEach(() => { drawn.views = 0; });

describe("a file of mine while it moves", () => {
  it("draws its message again only when the file fails, not at each step", () => {
    fakeEngine.update({ links: [linkView({ id: "chat1" })], transfers: { [ID]: moving(0) } });
    renderApp(<MessageBubble message={message} peerPubKey={linkView().peerPubKeyZ32} />);
    expect(screen.getByTestId("file-bubble")).toBeInTheDocument();
    const before = drawn.views;
    for (let i = 1; i <= 5; i++) act(() => fakeEngine.update({ transfers: { [ID]: moving(i * GB / 2) } }));
    expect(screen.getByTestId("file-status")).toHaveTextContent(/6[23]%/);
    expect(drawn.views - before).toBe(0);

    act(() => fakeEngine.update({ transfers: { [ID]: { ...moving(GB), state: "failed", error: "Connection lost", retry: true } } }));
    expect(drawn.views - before).toBeGreaterThan(0);
    // Its message's mark turns red: the view read the failure.
    expect(document.querySelector("[data-delivery=failed]")).not.toBeNull();
  });
});

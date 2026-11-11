import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatHoldDialog } from "../../components/ChatHoldDialog";
import type { PeerHoldState, PeerLinkState } from "../../lib/platform";
import { renderApp } from "../render";

// covers: delivery.hold.enable

/*
 * A chat's hold dialog: Save is busy while it saves, not disabled. A disabled button drops a keyboard's focus to the
 * page, and when the save is refused the dialog stays open with the focus on nothing, the next Tab from the top.
 */

const MB = 1024 * 1024;
const hold: PeerHoldState = { enabled: false, storage: true, canHold: true, outstanding: 0, bytes: 0, maxBytes: 64 * MB, maxItems: 64, ttlMs: 7 * 86_400_000, refused: 0 };
const peer = { hold, dataLink: "open" } as PeerLinkState;

describe("a chat's hold dialog, Save", () => {
  it("keeps the focus while it saves, takes no second press, and keeps it when the save is refused", async () => {
    let refuse!: (error: Error) => void;
    const onSave = vi.fn(() => new Promise<void>((_, reject) => { refuse = reject; }));
    const onClose = vi.fn();
    const { user } = renderApp(<ChatHoldDialog peer={peer} name="Ana" onSave={onSave} onClose={onClose} />);
    await user.click(screen.getByTestId("chat-hold-toggle"));
    const save = screen.getByTestId("chat-hold-save");
    save.focus();
    await user.keyboard("{Enter}");
    expect(onSave).toHaveBeenCalledExactlyOnceWith(true);
    expect(save).toHaveFocus();
    expect(save).toBeEnabled();
    expect(save).toHaveAttribute("aria-busy", "true");
    expect(save).toHaveTextContent("Saving");
    await user.keyboard("{Enter}");
    expect(onSave).toHaveBeenCalledTimes(1);
    // The switch takes no press while it saves either; Shift+Tab reaches it, Tab comes back to Save.
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(screen.getByTestId("chat-hold-toggle")).toHaveFocus();
    await user.keyboard(" ");
    expect(screen.getByTestId("chat-hold-toggle")).toHaveAttribute("aria-checked", "true");
    await user.tab();
    await user.tab();
    expect(save).toHaveFocus();
    await act(async () => { refuse(new Error("The storage answered 403")); });
    expect(screen.getByRole("alert")).toHaveTextContent("403");
    expect(onClose).not.toHaveBeenCalled();
    expect(save).not.toHaveAttribute("aria-busy");
    expect(save).toHaveTextContent("Save");
    expect(save).toHaveFocus();
  });

  it("stays disabled until the switch changes", async () => {
    const { user } = renderApp(<ChatHoldDialog peer={peer} name="Ana" onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByTestId("chat-hold-save")).toBeDisabled();
    await user.click(screen.getByTestId("chat-hold-toggle"));
    expect(screen.getByTestId("chat-hold-save")).toBeEnabled();
  });
});

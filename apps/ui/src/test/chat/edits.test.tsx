import { act, fireEvent, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageEdit } from "@ghostly/browser/shared/types";
import { MessageBubble } from "../../components/MessageBubble";
import { MessageInput } from "../../components/MessageInput";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { buildDetails } from "../../lib/messageDetails";
import type { ChatMessage } from "../../lib/types";
import { renderApp } from "../render";

// covers: chat.edit

/**
 * Editing a sent text (WISP 400 § Edits): ⋮ → Edit on mine, ↑ in an empty composer for the last one, the composer's
 * Editing bar, the "edited" mark beside the time, and the earlier versions in the details.
 */

const WIRE = "A".repeat(22);
const mine = (patch: Partial<ChatMessage> = {}): ChatMessage => ({ id: `me_${WIRE}`, ref: WIRE, text: "Working…", sender: "me", timestamp: 1_700_000_000_000, delivery: "delivered", ...patch });
const edited = (patch: Partial<MessageEdit> = {}): MessageEdit => ({ seq: 2, at: 1_700_000_060_000, history: [{ at: 1_700_000_000_000, text: "Working…" }, { at: 1_700_000_030_000, text: "Step 1" }], ...patch });

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("⋮ → Edit", () => {
  it("comes after Reply on a text of mine, and starts the edit", async () => {
    const onEdit = vi.fn();
    const { user } = renderApp(<MessageBubble message={mine()} peerPubKey="peer" onReply={() => {}} onEdit={onEdit} />);
    await user.click(screen.getByTestId("message-options"));
    const items = within(screen.getByTestId("message-menu")).getAllByRole("button").map(b => b.textContent);
    expect(items.slice(0, 2)).toEqual(["Reply", "Edit"]);
    await user.click(screen.getByTestId("message-edit"));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("message-menu")).not.toBeInTheDocument();
  });

  it("is not there without onEdit (the contact's messages, files, groups)", async () => {
    const { user } = renderApp(<MessageBubble message={mine({ sender: "peer", id: `peer_${WIRE}` })} peerPubKey="peer" />);
    await user.click(screen.getByTestId("message-options"));
    expect(screen.queryByTestId("message-edit")).not.toBeInTheDocument();
  });
});

describe("the edited mark", () => {
  it("says edited beside the time, with the time of the edit, and the latest text shows", () => {
    renderApp(<MessageBubble message={mine({ text: "Done", edit: edited() })} peerPubKey="peer" />);
    expect(screen.getByTestId("message-text")).toHaveTextContent("Done");
    const mark = screen.getByTestId("message-edited");
    expect(mark).toHaveTextContent("edited");
    expect(mark.getAttribute("title")).toMatch(/^Edited /);
    expect(mark).not.toHaveAttribute("data-pending");
  });

  it("says when the contact has not been shown it yet; none on a message never edited", () => {
    const { unmount } = renderApp(<MessageBubble message={mine({ edit: edited({ pending: true }) })} peerPubKey="peer" />);
    expect(screen.getByTestId("message-edited")).toHaveAttribute("data-pending", "true");
    expect(screen.getByTestId("message-edited")).toHaveAttribute("title", "Not shown to your contact yet");
    unmount();
    renderApp(<MessageBubble message={mine()} peerPubKey="peer" />);
    expect(screen.queryByTestId("message-edited")).not.toBeInTheDocument();
  });

  it("the details list the earlier versions, the original first", () => {
    const model = buildDetails(mine({ text: "Done", edit: edited() }), null);
    const section = model.sections.find(s => s.id === "edits")!;
    expect(section.title).toBe("Edits");
    expect(section.rows[0]).toMatchObject({ label: "Edits" });
    expect(section.rows[0].value).toMatch(/^2, the last at /);
    expect(section.rows.slice(1).map(r => [r.label.split(",")[0], r.value])).toEqual([["Original", "Working…"], ["Before", "Step 1"]]);
    expect(buildDetails(mine({ edit: edited({ pending: true }) }), null).sections.find(s => s.id === "edits")!.rows[1]).toMatchObject({ label: "Contact" });
    expect(buildDetails(mine(), null).sections.find(s => s.id === "edits")).toBeUndefined();
  });
});

describe("the composer while editing", () => {
  function Composer({ onSave, onSend = async () => null, last = mine() }: { onSave: (text: string) => Promise<string | null>; onSend?: (text: string) => Promise<string | null>; last?: ChatMessage }) {
    const [editing, setEditing] = useState<ChatMessage | null>(null);
    return <LockScreenProvider>
      <button onClick={() => setEditing(last)}>edit it</button>
      <MessageInput onSend={onSend} onEditLast={() => setEditing(last)}
        edit={editing ? { key: editing.id, text: editing.text, snippet: editing.text, onSave, onClose: () => setEditing(null) } : undefined} />
    </LockScreenProvider>;
  }
  const field = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message…");

  it("fills the field with the text, says Editing, and Enter saves the new text instead of sending", async () => {
    const onSave = vi.fn(async () => null), onSend = vi.fn(async () => null);
    const { user } = renderApp(<Composer onSave={onSave} onSend={onSend} />);
    await user.type(field(), "a draft");
    await user.click(screen.getByText("edit it"));
    const bar = screen.getByTestId("composer-edit");
    expect(within(bar).getByTestId("reply-quote-name")).toHaveTextContent("Editing");
    expect(within(bar).getByTestId("reply-quote-snippet")).toHaveTextContent("Working…");
    expect(field()).toHaveValue("Working…");
    expect(field()).toHaveFocus();
    await user.clear(field());
    await user.type(field(), "Done{Enter}");
    expect(onSave).toHaveBeenCalledWith("Done", undefined);
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByTestId("composer-edit")).not.toBeInTheDocument();
    // The draft comes back.
    expect(field()).toHaveValue("a draft");
  });

  it("an error keeps the edit open and says why", async () => {
    const { user } = renderApp(<Composer onSave={async () => "This message was edited 100 times, the most one takes."} />);
    await user.click(screen.getByText("edit it"));
    await user.type(field(), "!{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("edited 100 times");
    expect(screen.getByTestId("composer-edit")).toBeInTheDocument();
  });

  it("Escape or ✕ leaves the text as it was, and the draft comes back", async () => {
    const onSave = vi.fn(async () => null);
    const { user } = renderApp(<Composer onSave={onSave} />);
    await user.type(field(), "draft");
    await user.click(screen.getByText("edit it"));
    await user.type(field(), " more");
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("composer-edit")).not.toBeInTheDocument();
    expect(field()).toHaveValue("draft");
    await user.click(screen.getByText("edit it"));
    await user.click(screen.getByTestId("composer-edit-cancel"));
    expect(field()).toHaveValue("draft");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("the field goes back to one line when an edit of a long text ends, saved or not", async () => {
    const long = mine({ text: "A long message\nover two lines" });
    const { user } = renderApp(<Composer onSave={async () => null} last={long} />);
    // happy-dom lays nothing out: the field's content is 44px a line.
    Object.defineProperty(field(), "scrollHeight", { configurable: true, get() { return 44 * (this as HTMLTextAreaElement).value.split("\n").length; } });
    await user.click(screen.getByText("edit it"));
    expect(field().style.height).toBe("88px");
    await user.click(screen.getByTestId("composer-edit-cancel"));
    expect(field()).toHaveValue("");
    expect(field().style.height).toBe("44px");

    await user.click(screen.getByText("edit it"));
    expect(field().style.height).toBe("88px");
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("composer-edit")).not.toBeInTheDocument();
    expect(field().style.height).toBe("44px");
  });

  it("↑ in an empty field edits my last message; not while there is text", async () => {
    const { user } = renderApp(<Composer onSave={async () => null} />);
    await user.type(field(), "x");
    await user.keyboard("{ArrowUp}");
    expect(screen.queryByTestId("composer-edit")).not.toBeInTheDocument();
    await user.clear(field());
    await user.keyboard("{ArrowUp}");
    expect(screen.getByTestId("composer-edit")).toBeInTheDocument();
    expect(field()).toHaveValue("Working…");
  });

  it("the secret guard asks first, as it does for a new message", async () => {
    const onSave = vi.fn(async () => null);
    const { user } = renderApp(<Composer onSave={onSave} />);
    await user.click(screen.getByText("edit it"));
    await user.clear(field());
    act(() => { fireEvent.change(field(), { target: { value: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" } }); });
    await user.keyboard("{Enter}");
    expect(onSave).not.toHaveBeenCalled();
    expect(await screen.findByTestId("secret-guard-send")).toBeInTheDocument();
  });
});

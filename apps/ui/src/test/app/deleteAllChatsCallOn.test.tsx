import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { setChatOnCall } from "../../lib/chatsOnCall";
import { listSessions, saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { Settings } from "../../pages/Settings";
import { renderApp } from "../render";
import { windowIs } from "../viewport";

// covers: chats.list.delete-all

const chat = (id: string, key: string): ChatSession =>
  ({ id, profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: key.repeat(52), encKeyB64: "a2V5", messages: [], createdAt: 1_700_000_000_000 });

afterEach(() => setChatOnCall("a", false));

describe("Settings > Delete all chats while a call is on in a chat", () => {
  // Deleted under its call, the chat was gone and the call talked on; its hang-up then never crossed to the contact.
  it("says to end the call first and deletes nothing; once the call is over it deletes them all", async () => {
    windowIs(false);
    saveSession(chat("a", "a"));
    saveSession(chat("b", "b"));
    setChatOnCall("a", true);
    const { user } = renderApp(<LockScreenProvider><UpdateProvider><Settings /></UpdateProvider></LockScreenProvider>, { route: "/settings/storage" });

    const remove = await screen.findByTestId("delete-all-chats");
    await vi.waitFor(() => expect(remove).toBeEnabled());
    await user.click(remove);
    expect(screen.getByText("A call is on in a chat. End it first, then delete all chats.")).toBeInTheDocument();
    expect(screen.queryByText("Delete all 2 chats?")).not.toBeInTheDocument();
    const confirm = screen.getByTestId("delete-all-chats-confirm");
    expect(confirm).toBeDisabled();
    // The keys are not left on a button that went off: Cancel has them.
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(confirm);
    expect(listSessions()).toHaveLength(2);

    // The call ends while the confirm is open: it is on again, and deletes every chat.
    act(() => setChatOnCall("a", false));
    expect(screen.getByText("Delete all 2 chats?")).toBeInTheDocument();
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(listSessions()).toHaveLength(0);
  });
});

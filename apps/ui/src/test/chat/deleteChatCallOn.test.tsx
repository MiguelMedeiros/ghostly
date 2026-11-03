import { act, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { setChatOnCall } from "../../lib/chatsOnCall";
import { loadSession, saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { renderApp } from "../render";

// covers: chats.list.delete

const NOW = Date.now();
const chat = (id: string, nick: string): ChatSession =>
  ({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: id.repeat(52), encKeyB64: "enc", nick, messages: [], createdAt: NOW });
const rowOf = (name: string) => screen.getAllByTestId("chat-row").find(r => within(r).getByTestId("chat-row-name").textContent === name)!;

afterEach(() => setChatOnCall("a", false));

describe("Delete chat from the chat list while a call is on in that chat", () => {
  // Deleted under its call, the chat was gone and the call talked on; its hang-up then never crossed to the contact.
  it("says to end the call first and keeps the chat; once the call is over it deletes", async () => {
    saveSession(chat("a", "Ana"));
    saveSession(chat("b", "Bo"));
    setChatOnCall("a", true);
    const { user } = renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    await user.click(within(rowOf("Ana")).getByRole("button", { name: "Delete chat" }));
    const dialog = screen.getByRole("dialog", { name: "Delete chat?" });
    expect(dialog).toHaveAccessibleDescription("A call is on in this chat. End it first, then delete the chat.");
    const confirm = within(dialog).getByRole("button", { name: "Delete chat" });
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(loadSession("a")).not.toBeNull();

    // The call ends while the dialog is open: Delete is on again, and deletes.
    act(() => setChatOnCall("a", false));
    expect(dialog).toHaveAccessibleDescription(/^This deletes the chat and its history from this device/);
    await user.click(within(dialog).getByRole("button", { name: "Delete chat" }));
    expect(loadSession("a")).toBeNull();
  });

  // A call ringing while Delete held the focus turned it off under the focus: Chromium dropped it to the page, where
  // Tab went nowhere and only Escape left the dialog. Cancel takes it, as when the dialog opens.
  it("hands the focus to Cancel when a call starts while Delete has it", async () => {
    saveSession(chat("a", "Ana"));
    const { user } = renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    await user.click(within(rowOf("Ana")).getByRole("button", { name: "Delete chat" }));
    const dialog = screen.getByRole("dialog", { name: "Delete chat?" });
    await user.keyboard("{Tab}");
    expect(within(dialog).getByRole("button", { name: "Delete chat" })).toHaveFocus();
    act(() => setChatOnCall("a", true));
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("leaves another chat's delete as it was", async () => {
    saveSession(chat("a", "Ana"));
    saveSession(chat("b", "Bo"));
    setChatOnCall("a", true);
    const { user } = renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    await user.click(within(rowOf("Bo")).getByRole("button", { name: "Delete chat" }));
    const dialog = screen.getByRole("dialog", { name: "Delete chat?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete chat" }));
    expect(loadSession("b")).toBeNull();
    expect(loadSession("a")).not.toBeNull();
  });
});

import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { loadSession, saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chats.list.delete

const NOW = Date.now();
const chat = (id: string, nick: string): ChatSession =>
  ({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: id.repeat(52), encKeyB64: "enc", nick, messages: [], createdAt: NOW });
const rowOf = (name: string) => screen.getAllByTestId("chat-row").find(r => within(r).getByTestId("chat-row-name").textContent === name)!;
const PENDING = "A message you deleted for everyone hasn’t reached your contact yet: if you delete the chat now, they keep it.";

describe("Delete chat while a delete for everyone has not reached the contact", () => {
  // The chat's row went with the removal still on its way, and the contact kept the message for good: nothing said so.
  it("says the contact keeps the message, and Delete still deletes", async () => {
    saveSession(chat("a", "Ana"));
    // The engine's link of the chat, found by the contact's key: its id is not the chat's.
    const pending = linkView({ id: "link-a", peerPubKeyZ32: "a".repeat(52), removalsPending: ["me_1"] });
    fakeEngine.setState({ links: [pending] });
    const { user } = renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    await user.click(within(rowOf("Ana")).getByRole("button", { name: "Delete chat" }));
    const dialog = screen.getByRole("dialog", { name: "Delete chat?" });
    expect(dialog).toHaveAccessibleDescription(/^This deletes the chat and its history from this device\. .+ A message you deleted for everyone/);
    expect(within(dialog).getByText(PENDING)).toBeVisible();

    // The removal reaches the contact while the dialog is open: the line goes.
    act(() => fakeEngine.setState({ links: [{ ...pending, removalsPending: undefined }] }));
    expect(within(dialog).queryByText(PENDING)).toBeNull();
    act(() => fakeEngine.setState({ links: [pending] }));
    const confirm = within(dialog).getByRole("button", { name: "Delete chat" });
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(loadSession("a")).toBeNull();
  });

  it("says nothing of it for a chat with no removal on its way", async () => {
    saveSession(chat("b", "Bo"));
    fakeEngine.setState({ links: [linkView({ id: "link-b", peerPubKeyZ32: "b".repeat(52) }), linkView({ id: "link-c", peerPubKeyZ32: "c".repeat(52), removalsPending: ["me_2"] })] });
    const { user } = renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    await user.click(within(rowOf("Bo")).getByRole("button", { name: "Delete chat" }));
    const dialog = screen.getByRole("dialog", { name: "Delete chat?" });
    expect(within(dialog).queryByText(PENDING)).toBeNull();
  });
});

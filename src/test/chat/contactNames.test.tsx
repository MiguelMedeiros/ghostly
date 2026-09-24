import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { Profile } from "../../pages/Profile";
import { engineState, fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chats.list.unnamed-contact, chat.paired.nickname-sync, profiles.share

const JPEG = "data:image/jpeg;base64,/9j/4AAQ";
const key = (c: string) => c.repeat(52);
const chat = (id: string, over: Partial<ChatSession> = {}): ChatSession =>
  ({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: key(id), encKeyB64: "enc", messages: [], createdAt: 1, ...over });
const rowOf = (text: string | RegExp) => screen.getByText(text).closest<HTMLElement>("div.cursor-pointer")!;

describe("the chat list names every contact", () => {
  it("by the name they gave, by the one given here first, and a contact with neither by a steady tag and pattern", () => {
    saveSession(chat("a", { nick: "Alice", nickSource: "profile" }));
    saveSession(chat("b", { nick: "Bob", label: "My brother" }));
    saveSession(chat("c"));
    saveSession(chat("d"));
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    act(() => fakeEngine.update({ links: [linkView({ id: "l-d", peerPubKeyZ32: key("d"), peerAvatar: JPEG })] }));

    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("My brother")).toBeInTheDocument();
    expect(screen.queryByText("Bob")).not.toBeInTheDocument();
    expect(screen.queryByText("Anonymous")).not.toBeInTheDocument();
    // No name, no picture: the start of the key and a pattern drawn from it.
    const unnamed = rowOf("Contact · cccccc");
    expect(within(unnamed).getByTestId("identicon")).toBeInTheDocument();
    // No name but a picture: the picture.
    const pictured = rowOf("Contact · dddddd");
    expect(within(pictured).queryByTestId("identicon")).not.toBeInTheDocument();
    expect(within(pictured).getByTestId("chat-row-avatar")).toHaveAttribute("src", JPEG);
    // A named contact with no picture keeps their initial.
    expect(within(rowOf("Alice")).queryByTestId("identicon")).not.toBeInTheDocument();
    expect(within(rowOf("Alice")).getByText("A")).toBeInTheDocument();
  });

  it("draws the same pattern for the same key and a different one for another", () => {
    saveSession(chat("e"));
    saveSession(chat("f"));
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    const pattern = (text: string) => within(rowOf(text)).getByTestId("identicon").outerHTML;
    expect(pattern("Contact · eeeeee")).not.toBe(pattern("Contact · ffffff"));
    expect(pattern("Contact · eeeeee")).toBe(pattern("Contact · eeeeee"));
  });
});

describe("Profile: sharing the name and picture", () => {
  it("is on by default and switches off and on again for this profile", async () => {
    const { user, engine } = renderApp(<Profile />);
    engine.on("updateSettings", ({ settings }) => { act(() => engine.update({ settings: { ...engine.state.settings, ...settings } })); });
    const share = screen.getByTestId("profile-share");
    expect(share).toHaveAttribute("aria-checked", "true");
    expect(share).toHaveAccessibleName("Share my name and picture with contacts");
    await user.click(share);
    expect(engine.callsTo("updateSettings")).toContainEqual({ settings: { shareProfile: false } });
    expect(await screen.findByTestId("profile-share")).toHaveAttribute("aria-checked", "false");
    await user.click(screen.getByTestId("profile-share"));
    expect(engine.callsTo("updateSettings")).toContainEqual({ settings: { shareProfile: true } });
    expect(engineState().settings.shareProfile).toBeUndefined();
  });
});

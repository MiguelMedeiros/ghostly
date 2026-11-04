import "fake-indexeddb/auto";
import { act, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileBubble } from "../../components/FileBubble";
import { MessageBubble } from "../../components/MessageBubble";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { saveInviteCode, saveSession } from "../../lib/storage";
import { servicesPlatform } from "../../lib/platform";
import { Chat } from "../../pages/Chat";
import { Home } from "../../pages/Home";
import { fakeEngine, linkView } from "../fakeEngine";
import { everythingOnScreen } from "../onScreen";
import { renderApp } from "../render";

// covers: app.accessibility

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

/*
 * A drawing with no name and no aria-hidden stays in the accessibility tree as an unnamed image: VoiceOver and TalkBack
 * stop on it and say "image". The bubble's tail alone made one such stop per message.
 */

/** The svgs in `root` a screen reader stops on: none hidden, by itself or by what holds it. */
const exposed = (root: ParentNode) => [...root.querySelectorAll("svg")].filter(svg => !svg.closest("[aria-hidden=true]"));

beforeEach(() => everythingOnScreen());

describe("decorative drawings are hidden from screen readers", () => {
  it("a message's tail, sent or received", () => {
    const received = renderApp(<MessageBubble message={{ id: "m1", text: "hello", sender: "peer", timestamp: 1_700_000_000_000 }} peerPubKey="peer" />);
    expect(exposed(received.container)).toEqual([]);
    received.unmount();
    const sent = renderApp(<MessageBubble message={{ id: "m2", text: "hi", sender: "me", timestamp: 1_700_000_000_000, delivery: "sent" }} peerPubKey="peer" />);
    expect(exposed(sent.container)).toEqual([]);
  });

  it("the icon of a join line", () => {
    renderApp(<MessageBubble message={{ id: "j", text: "", sender: "system", timestamp: 1, systemEvent: { type: "join", pubKey: "peer" } }} peerPubKey="peer" peerNick="Ana" />);
    expect(exposed(screen.getByTestId("join-line"))).toEqual([]);
  });

  it("the icon of a file with no preview", () => {
    vi.spyOn(servicesPlatform!, "getFile").mockResolvedValue(null);
    fakeEngine.update({ links: [linkView({ id: "chat1" })], transfers: {} });
    const { container } = renderApp(<FileBubble file={{ id: "chat1-in-abc", name: "notes.pdf", size: 1000, mime: "application/pdf" }} peerName="Ana" />);
    expect(container.querySelector("svg")).not.toBeNull();
    expect(exposed(container)).toEqual([]);
  });

  it("the chat list's search icon and the ghost of an empty list", () => {
    fakeEngine.update({ groups: [], groupsLoaded: true });
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    expect(screen.getByText("It's quiet here...")).toBeInTheDocument();
    const search = screen.getByPlaceholderText("Search chats...").parentElement!;
    expect(exposed(search)).toEqual([]);
    expect(exposed(screen.getByTestId("chat-list"))).toEqual([]);
  });

  it("the ghost of the home screen", () => {
    const { container } = renderApp(<Home />);
    expect(exposed(container.querySelector("h1")!.parentElement!)).toEqual([]);
  });

  it("the star on a chat made here keeps its meaning in words, its drawing hidden", async () => {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: "peer".padEnd(52, "p"), encKeyB64: "a2V5", participationSeedB64: "cGFydA", messages: [], createdAt: Date.now() });
    saveInviteCode("chat-1", "ghostly1-invite");
    const { engine } = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
    engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined);
    await act(async () => {});
    const star = screen.getByText("You created this chat").parentElement!;
    expect(star.querySelector("svg")).not.toBeNull();
    expect(exposed(star)).toEqual([]);
  });
});

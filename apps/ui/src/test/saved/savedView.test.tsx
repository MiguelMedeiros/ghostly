import { act, screen, waitFor, within } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { SavedMessage, StoredMessage } from "@ghostly/browser/shared/types";
import { SidebarSaved } from "../../components/saved/SidebarSaved";
import { saveSession } from "../../lib/storage";
import { Saved } from "../../pages/Saved";
import { groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.saved

/** The Saved view: the profile's saved messages from every chat and group, each opening its chat on its message. */

const PEER = "peerkeyalice";
const NOW = Date.now();
const message = (linkId: string, id: string, patch: Partial<StoredMessage> = {}): StoredMessage => ({ linkId, id, text: `text ${id}`, sender: "peer", timestamp: NOW - 5 * 60_000, via: "datalink", ...patch });
const saved = (m: StoredMessage, savedAt = NOW): SavedMessage => ({ savedAt, message: m });

function Where() {
  const location = useLocation();
  return <p data-testid="where" data-jump={String((location.state as { jumpTo?: string } | null)?.jumpTo ?? "")}>{location.pathname}</p>;
}

const state = {
  links: [linkView({ id: "link-1", peerPubKeyZ32: PEER, peerNick: "Alice" })],
  groups: [groupView({ id: "g1", name: "Crew", status: "active", canSend: true, members: [{ key: "me-key", me: true, nick: "Me" }, { key: "hermes-key", me: false, nick: "Hermes" }] as never })],
};

function profile(rows: SavedMessage[], ui = <><Saved /><Where /></>, language?: "pt") {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", messages: [], createdAt: 1_700_000_000_000, nick: "Alice" });
  let current = rows;
  const rendered = renderApp(ui, { route: "/saved", language });
  rendered.engine.on("savedMessages", () => current).on("saveMessage", (params) => {
    current = current.filter((s) => !(s.message.linkId === params.linkId && s.message.id === params.messageId));
    return { error: null };
  }).setState(state);
  return { ...rendered, set: (next: SavedMessage[]) => { current = next; } };
}

const texts = () => screen.getAllByTestId("saved-row").map((row) => within(row).getByTestId("saved-text").textContent);

describe("the Saved view", () => {
  it("lists the saved messages of chats and groups, the last saved first, with where they are and who wrote them", async () => {
    profile([
      saved(message("group:g1", "k:1", { member: "hermes-key", text: "deploy at 5" }), NOW),
      saved(message("link-1", "me_1", { sender: "me", text: "my note" }), NOW - 1000),
      saved(message("link-1", "peer_2", { text: "the address" }), NOW - 2000),
    ]);
    await waitFor(() => expect(screen.getAllByTestId("saved-row")).toHaveLength(3));
    expect(texts()).toEqual(["deploy at 5", "my note", "the address"]);
    const [group, mine, theirs] = screen.getAllByTestId("saved-row");
    expect(within(group).getByTestId("saved-chat")).toHaveTextContent("Crew");
    expect(within(group).getByTestId("saved-author")).toHaveTextContent("Hermes");
    expect(within(mine).getByTestId("saved-chat")).toHaveTextContent("Alice");
    expect(within(mine).getByTestId("saved-author")).toHaveTextContent("You");
    // In a 1:1 chat the contact is the chat: named once.
    expect(within(theirs).queryByTestId("saved-author")).not.toBeInTheDocument();
    expect(within(theirs).getByTestId("saved-open")).toHaveAccessibleName("Open in Alice: the address");
  });

  it("says a voice message or a video in the app's language, not in the English the history keeps", async () => {
    profile([
      saved(message("link-1", "peer_1", { text: "🎤 Voice message (0:02)", file: { id: "f1", name: "voice.webm", size: 10, mime: "audio/webm", voice: { duration: 2_000, peaks: [] } } })),
      saved(message("link-1", "peer_2", { text: "🎬 Video (0:07)", file: { id: "f2", name: "clip.mp4", size: 10, mime: "video/mp4", video: { duration: 7_000, width: 640, height: 360 } } })),
      saved(message("link-1", "peer_3", { text: "📎 notes.pdf", file: { id: "f3", name: "notes.pdf", size: 10, mime: "application/pdf" } })),
    ], undefined, "pt");
    await waitFor(() => expect(texts()).toEqual(["🎤 Mensagem de voz (0:02)", "🎬 Vídeo (0:07)", "📎 notes.pdf"]));
    expect(within(screen.getAllByTestId("saved-row")[0]).getByTestId("saved-open")).toHaveAccessibleName("Abrir em Alice: 🎤 Mensagem de voz (0:02)");
  });

  it("opens a message's chat on the message", async () => {
    const { user } = profile([saved(message("group:g1", "k:1", { member: "hermes-key" })), saved(message("link-1", "peer_2"))]);
    const rows = await screen.findAllByTestId("saved-row");
    await user.click(within(rows[1]).getByTestId("saved-open"));
    expect(screen.getByTestId("where")).toHaveTextContent("/chat/chat-1");
    expect(screen.getByTestId("where")).toHaveAttribute("data-jump", "peer_2");
    await user.click(within(screen.getAllByTestId("saved-row")[0]).getByTestId("saved-open"));
    expect(screen.getByTestId("where")).toHaveTextContent("/group/g1");
    expect(screen.getByTestId("where")).toHaveAttribute("data-jump", "k:1");
  });

  it("unsaves a message from its row", async () => {
    const { user, engine } = profile([saved(message("link-1", "peer_1")), saved(message("link-1", "peer_2"))]);
    const rows = await screen.findAllByTestId("saved-row");
    await user.click(within(rows[0]).getByTestId("saved-unsave"));
    expect(engine.callsTo("saveMessage")).toEqual([{ linkId: "link-1", messageId: "peer_1", remove: true }]);
    await waitFor(() => expect(texts()).toEqual(["text peer_2"]));
  });

  it("after an unsave from the keyboard, the focus goes to the next row, the one before it at the end, then to the empty list", async () => {
    const { user } = profile([saved(message("link-1", "peer_1")), saved(message("link-1", "peer_2")), saved(message("link-1", "peer_3"))]);
    const opens = () => screen.getAllByTestId("saved-open");
    await screen.findAllByTestId("saved-row");
    within(screen.getAllByTestId("saved-row")[1]).getByTestId("saved-unsave").focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(texts()).toEqual(["text peer_1", "text peer_3"]));
    expect(opens()[1]).toHaveFocus();
    // The last row: the one before it.
    within(screen.getAllByTestId("saved-row")[1]).getByTestId("saved-unsave").focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(texts()).toEqual(["text peer_1"]));
    expect(opens()[0]).toHaveFocus();
    // The only one: the empty list says so, and has the focus.
    within(screen.getByTestId("saved-row")).getByTestId("saved-unsave").focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByTestId("saved-empty")).toHaveFocus();
  });

  it("shows an edit's latest text when the chat changes, and says when nothing is saved", async () => {
    const m = message("link-1", "peer_1", { text: "before" });
    const { set, engine } = profile([saved(m)]);
    await waitFor(() => expect(texts()).toEqual(["before"]));
    const edited = { ...m, text: "after", edit: { seq: 1, at: NOW, history: [] } };
    set([saved(edited)]);
    act(() => engine.messages("link-1", [edited]));
    await waitFor(() => expect(texts()).toEqual(["after"]));

    set([]);
    act(() => engine.messages("link-1", []));
    expect(await screen.findByTestId("saved-empty")).toHaveTextContent("No saved messages");
  });

  it("is reached from above the chat list only while something is saved, with how many", async () => {
    const { set, engine } = profile([], <SidebarSaved active={false} onOpen={() => {}} />);
    await waitFor(() => expect(engine.callsTo("savedMessages").length).toBeGreaterThan(0));
    expect(screen.queryByTestId("sidebar-saved")).not.toBeInTheDocument();
    set([saved(message("link-1", "peer_1")), saved(message("group:g1", "k:1", { member: "hermes-key" }))]);
    // A chat or a group coming is one way the list is read again.
    act(() => engine.setState({ ...state, groups: [...state.groups, groupView({ id: "g2", name: "Other", status: "active" })] }));
    const entry = await screen.findByTestId("sidebar-saved");
    expect(entry).toHaveAccessibleName("Saved messages, 2");
  });
});

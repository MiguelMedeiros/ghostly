import { act, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SavedMessage, StoredMessage } from "@ghostly/browser/shared/types";
import { SidebarSaved } from "../../components/saved/SidebarSaved";
import { groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.saved

/** When the saved messages are read again: a chat or a group coming or going, not the chat list's order changing. */

const NOW = Date.now();
const message = (linkId: string, id: string): StoredMessage => ({ linkId, id, text: `text ${id}`, sender: "peer", timestamp: NOW - 60_000, via: "datalink" });
const rows: SavedMessage[] = [{ savedAt: NOW, message: message("group:g1", "k:1") }];

const links = [linkView({ id: "link-1", peerPubKeyZ32: "peerkeyalice", peerNick: "Alice" })];
const g1 = groupView({ id: "g1", name: "Crew", status: "active", lastMessageAt: NOW - 2000 });
const g2 = groupView({ id: "g2", name: "Other", status: "active", lastMessageAt: NOW - 1000 });

/** Past the store's settle time, so a read it would make is made. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 300)));

describe("the saved messages' reads", () => {
  it("are not made again when a message moves a group up the list, and are when a chat or group comes or goes", async () => {
    const { engine } = renderApp(<SidebarSaved active={false} onOpen={() => {}} />, { route: "/" });
    engine.on("savedMessages", () => rows).setState({ links, groups: [g2, g1] });
    await waitFor(() => expect(engine.callsTo("savedMessages")).toHaveLength(1));
    await settle();
    const before = engine.callsTo("savedMessages").length;

    // A message in Crew puts it first, ten times over with the other group: the same chats and groups.
    for (let i = 0; i < 10; i++) {
      act(() => engine.setState({ links, groups: i % 2 ? [g2, g1] : [{ ...g1, lastMessageAt: NOW + i }, g2] }));
      await settle();
    }
    expect(engine.callsTo("savedMessages")).toHaveLength(before);

    // A group going takes its saved messages with it: read again.
    act(() => engine.setState({ links, groups: [g2] }));
    await waitFor(() => expect(engine.callsTo("savedMessages")).toHaveLength(before + 1));
    // A chat coming is read again too.
    act(() => engine.setState({ links: [...links, linkView({ id: "link-2", peerPubKeyZ32: "peerkeybob", peerNick: "Bob" })], groups: [g2] }));
    await waitFor(() => expect(engine.callsTo("savedMessages")).toHaveLength(before + 2));
  });
});

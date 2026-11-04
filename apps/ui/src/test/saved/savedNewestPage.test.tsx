import { act, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MESSAGE_CHANGES_TICK_MS } from "@ghostly/browser/platform/engine";
import type { SavedMessage, StoredMessage } from "@ghostly/browser/shared/types";
import { SidebarSaved } from "../../components/saved/SidebarSaved";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.saved

/*
 * The saved messages' reads in a chat the engine sent only its newest page (the extension's tabs): a saved message older
 * than that page is not in the page's list, and that says nothing of it. Each message coming into the chat does not read
 * the saved messages again; an edit or a delete of a saved one still does.
 */

const NOW = Date.now();
const LINK = "link-1";
const N = 2_000;
const PAGE = 400;
const row = (i: number, extra: Partial<StoredMessage> = {}): StoredMessage =>
  ({ linkId: LINK, id: `peer_${i}`, text: `message ${i}`, sender: "peer", timestamp: NOW - (N - i) * 1_000, via: "datalink", ...extra });
const saved: SavedMessage[] = [{ savedAt: NOW, message: row(5) }];

/** Past the store's settle time and the engine's tick, so a read it would make is made. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 300 + MESSAGE_CHANGES_TICK_MS)));

describe("the saved messages' reads, in a chat sent as its newest page", () => {
  it("are not made again for each message that comes, and are for an edit or a delete of a saved one", async () => {
    const { engine } = renderApp(<SidebarSaved active={false} onOpen={() => {}} />, { route: "/" });
    engine.on("savedMessages", () => saved).setState({ links: [linkView({ id: LINK, peerPubKeyZ32: "peerkeyalice", peerNick: "Alice" })] });
    await waitFor(() => expect(engine.callsTo("savedMessages")).toHaveLength(1));
    const all = Array.from({ length: N }, (_, i) => row(i));
    act(() => engine.newestPage(LINK, all.slice(-PAGE)));
    await settle();
    const before = engine.callsTo("savedMessages").length;

    for (let i = 0; i < 10; i++) {
      act(() => engine.emit({ kind: "message-changes", linkId: LINK, messages: [row(N + i, { timestamp: NOW + i })], deleted: [] }));
      await settle();
    }
    expect(engine.callsTo("savedMessages")).toHaveLength(before);

    // The saved one edited: its row comes, with its new text.
    act(() => engine.emit({ kind: "message-changes", linkId: LINK, messages: [row(5, { text: "edited", edit: { at: NOW, seq: 1, history: [] } })], deleted: [] }));
    await waitFor(() => expect(engine.callsTo("savedMessages")).toHaveLength(before + 1));
    await settle();
    // The saved one deleted.
    act(() => engine.emit({ kind: "message-changes", linkId: LINK, messages: [], deleted: ["peer_5"] }));
    await waitFor(() => expect(engine.callsTo("savedMessages")).toHaveLength(before + 2));
  });

  it("are made again when the whole history comes without a saved message", async () => {
    const { engine } = renderApp(<SidebarSaved active={false} onOpen={() => {}} />, { route: "/" });
    engine.on("savedMessages", () => saved).setState({ links: [linkView({ id: LINK, peerPubKeyZ32: "peerkeyalice", peerNick: "Alice" })] });
    await waitFor(() => expect(engine.callsTo("savedMessages")).toHaveLength(1));
    await settle();
    act(() => engine.messages(LINK, Array.from({ length: N }, (_, i) => row(i)).filter((m) => m.id !== "peer_5")));
    await waitFor(() => expect(engine.callsTo("savedMessages")).toHaveLength(2));
  });
});

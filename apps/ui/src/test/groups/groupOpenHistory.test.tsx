import { act, screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { MESSAGE_CHANGES_TICK_MS } from "@ghostly/browser/platform/engine";
import type { GroupMemberView, StoredMessage } from "@ghostly/browser/shared/types";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: groups.send

/**
 * A group opened again reads nothing from the store: its first open asks the engine for its whole history once
 * (`HistoryRequest`), which the engine then keeps current on this page with what changes in it. Before, each open read
 * the group's whole history (`groupMessages`), and the engine, not knowing the page had it, read it whole again at its
 * next message.
 */

const ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
// More than a page (50), so the whole history is more than the page holds; small enough that a loaded machine draws each
// open well within the timeout (300 rows and four opens took over 5 s there).
const COUNT = 60;
const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, MESSAGE_CHANGES_TICK_MS * 2)));

describe("a group opened again", () => {
  it("reads its whole history once, and shows what changes on top of it", async () => {
    const groupId = "group-reopened", linkId = `group:${groupId}`;
    const row = (i: number): StoredMessage => ({ linkId, id: `g${i}`, text: `Message ${i}`, sender: "peer", member: ALICE, timestamp: 1_700_000_000_000 + i * 60_000, via: "datalink" });
    const history = Array.from({ length: COUNT }, (_, i) => row(i));
    fakeEngine.on("messagePage", () => ({ messages: history.slice(-50), more: true }))
      .on("groupMessages", () => history)
      .on("updateSettings", () => undefined)
      .update({ groups: [groupView({ id: groupId, status: "active", epoch: 1, members: [member({ key: ME, me: true }), member({ key: ALICE, nick: "Alice" })] })] });
    const open = async () => {
      const view = renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: `/group/${groupId}` });
      await screen.findByText(`Message ${COUNT - 1}`);
      await tick();
      return view;
    };

    (await open()).unmount();
    await open();
    const wholeReads = () => fakeEngine.callsTo("groupMessages").length + fakeEngine.historyAsks.filter((id) => id === linkId).length;
    expect(wholeReads()).toBe(1);

    // Its next message comes as a change of the history the page holds.
    act(() => fakeEngine.emit({ kind: "message-changes", linkId, messages: [row(COUNT)], deleted: [] }));
    expect(await screen.findByText(`Message ${COUNT}`)).toBeInTheDocument();
    expect(wholeReads()).toBe(1);
  });
});

import { act, screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { GroupMemberView, StoredMessage } from "@ghostly/browser/shared/types";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: groups.send

/*
 * A long group's page draws on every engine state (up to 20 a second) and gets a new list with each message, whose rows
 * keep their objects. It read every row of the history each time; as a 1:1 chat's page, it reads only the rows that
 * changed. The rows far above the page's window count every read of them here.
 */

const ME = "me".padEnd(52, "y"), BOT = "bot".padEnd(52, "y");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
const stored = (i: number): StoredMessage =>
  ({ linkId: "group:group-1", id: `g${i}`, text: `Message ${i}`, sender: "peer", member: BOT, timestamp: 1_700_000_000_000 + i * 60_000, via: "datalink" });

function setUp() {
  const reads: string[] = [];
  const counted = (row: StoredMessage) => new Proxy(row, { get(target, key, receiver) { reads.push(String(key)); return Reflect.get(target, key, receiver); } });
  // Older than the page's window of rows: nothing draws them.
  const history = [...Array.from({ length: 200 }, (_, i) => counted(stored(i))), ...Array.from({ length: 100 }, (_, i) => stored(200 + i))];
  const view = groupView({ status: "active", epoch: 1, members: [member({ key: ME, me: true }), member({ key: BOT, nick: "Builder" })] });
  fakeEngine.on("groupMessages", () => history).on("updateSettings", () => undefined).on("setGroupTyping", () => undefined).update({ groups: [view] });
  renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
  return { reads, history, view };
}

describe("a long group", () => {
  it("reads no row of its history on an engine state that changed none of them", async () => {
    const { reads, view } = setUp();
    await screen.findByText("Message 299");
    reads.length = 0;

    act(() => fakeEngine.update({ groups: [{ ...view }] }));
    expect(reads).toEqual([]);
  });

  it("reads only the new row's words and cards when a message comes", async () => {
    const { reads, history } = setUp();
    await screen.findByText("Message 299");
    reads.length = 0;

    act(() => fakeEngine.messages("group:group-1", [...history, stored(300)]));
    await screen.findByText("Message 300");
    expect(reads.filter(key => ["text", "card", "replyTo", "mentions"].includes(key))).toEqual([]);
  });
});

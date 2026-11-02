import { act, screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { readStatusCard } from "@ghostly/core";
import type { GroupMemberView, StoredMessage } from "@ghostly/browser/shared/types";
import { GroupChat } from "../../pages/GroupChat";
import type { CardRow } from "../../lib/statusCards";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.status-cards

/*
 * A group's Tasks button lists its bots' tasks and routines. It was given every message, and read the whole history on
 * each one that came; it gets the rows with a task or a routine, found in the rows that changed (as a 1:1 chat's).
 */

const given = vi.hoisted(() => ({ rows: [] as (readonly CardRow[])[] }));
vi.mock("../../components/chat/TasksButton", () => ({ TasksButton: ({ rows }: { rows: readonly CardRow[] }) => { given.rows.push(rows); return null; } }));

const ME = "me".padEnd(52, "y"), BOT = "bot".padEnd(52, "y");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
const task = (id: string) => readStatusCard({ kind: "task", id, title: `Task ${id}`, status: "running" })!;
const stored = (i: number, patch: Partial<StoredMessage> = {}): StoredMessage =>
  ({ linkId: "group:group-1", id: `g${i}`, text: `Message ${i}`, sender: "peer", member: BOT, timestamp: 1_700_000_000_000 + i * 60_000, via: "datalink", ...patch });

describe("a group's Tasks button", () => {
  it("is given only the rows with a task or a routine, and no new list for a message without one", async () => {
    const history = Array.from({ length: 300 }, (_, i) => stored(i, i % 100 === 50 ? { card: task(`t${i}`) } : {}));
    fakeEngine.on("groupMessages", () => history).on("updateSettings", () => undefined).on("setGroupTyping", () => undefined)
      .update({ groups: [groupView({ status: "active", epoch: 1, members: [member({ key: ME, me: true }), member({ key: BOT, nick: "Builder" })] })] });
    renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
    await screen.findByText("Message 299");

    const rows = given.rows[given.rows.length - 1]!;
    expect(rows.map(r => r.id)).toEqual(["g50", "g150", "g250"]);

    // A text comes (the engine sends the list again, its rows the same): the button keeps its rows.
    const text = [...history, stored(300)];
    act(() => fakeEngine.messages("group:group-1", text));
    await screen.findByText("Message 300");
    expect(given.rows[given.rows.length - 1]).toBe(rows);

    // A task comes: it is there.
    act(() => fakeEngine.messages("group:group-1", [...text, stored(301, { card: task("t301") })]));
    await screen.findByText("Task t301");
    expect(given.rows[given.rows.length - 1]!.map(r => r.id)).toEqual(["g50", "g150", "g250", "g301"]);
  });
});

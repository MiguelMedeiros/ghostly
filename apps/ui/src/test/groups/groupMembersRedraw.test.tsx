// The engine sends its whole state anew on every change (up to 20 a second while a file moves). An open members panel
// draws again only when what it shows changes, as the open group does (groupStateRedraw.test.tsx): with a community's
// 256 members, a state that changes none of them worked out every row again.
import { Profiler } from "react";
import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { GroupMemberView } from "@ghostly/browser/shared/types";
import { GroupMembersDialog } from "../../components/GroupMembersDialog";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: groups.connection

const key = (i: number) => `m${i}`.padEnd(52, "y");
const member = (i: number, nick = `Member ${i}`): GroupMemberView => ({ key: key(i), role: i === 1 ? "admin" : "member", me: i === 0, online: true, missing: 0, nick });
/** A community of 40, its contact's chat and another, and a file moving: each a new object, as every state of the engine brings them. */
const state = (patch: { transfer?: number; nick?: string } = {}) => ({
  groups: [groupView({ id: "group-1", status: "active", epoch: 1, profile: "community", isAdmin: true, myKey: key(0), memberLinks: { "link-2": key(2) },
    members: Array.from({ length: 40 }, (_, i) => member(i, i === 3 && patch.nick ? patch.nick : undefined)) })],
  links: [linkView({ id: "link-2", peerPubKeyZ32: key(2), profile: "paired-chat/1" } as never), linkView({ id: "link-cy", peerPubKeyZ32: "cy".padEnd(52, "y"), profile: "paired-chat/1" } as never)],
  ...(patch.transfer !== undefined && { transfers: { [`t${patch.transfer}`]: { bytes: patch.transfer } } }),
});

describe("an engine state that changes nothing of an open members panel", () => {
  it("draws it not at all", async () => {
    fakeEngine.update(state() as never);
    let draws = 0;
    renderApp(
      <Profiler id="members" onRender={() => { draws++; }}>
        <GroupMembersDialog group={fakeEngine.state.groups[0]} onClose={() => {}} />
      </Profiler>,
    );
    expect(await screen.findAllByTestId("group-member")).toHaveLength(40);

    draws = 0;
    for (let i = 0; i < 20; i++) act(() => fakeEngine.update(state({ transfer: i }) as never));
    expect(draws).toBe(0);

    // A member's name changing still draws it, and their row says the new name.
    act(() => fakeEngine.update(state({ nick: "Ana Lima" }) as never));
    expect(draws).toBeGreaterThan(0);
    expect(within(screen.getByTestId("group-member-list")).getByText("Ana Lima")).toBeInTheDocument();
  });
});

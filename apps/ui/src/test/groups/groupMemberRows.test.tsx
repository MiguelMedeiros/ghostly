import { act, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GroupEdgeView, GroupMemberView, GroupView } from "@ghostly/browser/shared/types";
import { GroupMembersDialog } from "../../components/GroupMembersDialog";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: groups.connection

// How often a member's name is worked out: once or more each time their row is drawn.
const names = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../lib/groups", async original => {
  const actual = await original<typeof import("../../lib/groups")>();
  const memberName: typeof actual.memberName = (m, t) => { names.count++; return actual.memberName(m, t); };
  return { ...actual, memberName };
});

const ME = "me".padEnd(52, "y");
const keyOf = (i: number) => `m${i}`.padEnd(52, "y");
const MEMBERS = 40;
/** The roster as each of the engine's states carries it: the same members, in new objects. */
const edge = (i: number, state: GroupEdgeView["state"] = "open"): GroupEdgeView => ({ linkId: `edge-${i}`, state, transport: "webrtc/1", lastSeenAt: 0 });
const roster = (patch: (m: GroupMemberView) => Partial<GroupMemberView> = () => ({})): GroupMemberView[] => [
  { key: ME, role: "admin" as const, me: true, online: true, missing: 0 },
  ...Array.from({ length: MEMBERS - 1 }, (_, i): GroupMemberView => ({ key: keyOf(i), role: "member", me: false, online: true, missing: 0, nick: `Member ${i}`, edge: edge(i) })),
].map((m): GroupMemberView => ({ ...m, ...patch(m) }));
const group = (patch: Partial<GroupView> = {}) => groupView({ status: "active", epoch: 1, isAdmin: true, myKey: ME, members: roster(), ...patch });

function openMembers() {
  fakeEngine.update({ groups: [group()] });
  const view = renderApp(<GroupMembersDialog group={group()} onClose={() => {}} />);
  expect(screen.getAllByTestId("group-member")).toHaveLength(MEMBERS);
  return view;
}
const rowOf = (key: string) => screen.getAllByTestId("group-member").find(row => row.dataset.key === key)!;

describe("GroupMembersDialog: a large roster", () => {
  it("a state that changes no member draws no member's row again", () => {
    openMembers();
    names.count = 0;
    // Something else changed (an edge of a chat came up): the group is the same, in new objects, as every state brings it.
    act(() => fakeEngine.update({ groups: [group()], links: [linkView({ id: "link-other", peerPubKeyZ32: "otherpeer" })] }));
    // Before, all 40 rows were drawn again, each naming its member twice.
    expect(names.count).toBe(0);
  });

  it("the row of a member whose connection or name changed says so at once, and only that row is drawn", () => {
    openMembers();
    expect(within(rowOf(keyOf(3))).getByTestId("group-member-status")).toHaveTextContent("Connected");
    names.count = 0;
    act(() => fakeEngine.update({ groups: [group({ members: roster(m => m.key === keyOf(3) ? { nick: "Renamed", edge: edge(3, "connecting") } : {}) })] }));
    expect(rowOf(keyOf(3))).toHaveTextContent("Renamed");
    expect(within(rowOf(keyOf(3))).getByTestId("group-member-status")).toHaveTextContent("Connecting");
    expect(names.count).toBeLessThan(MEMBERS);
  });

  it("while one member is being removed, no row's buttons can be pressed", async () => {
    let done!: () => void;
    fakeEngine.on("removeGroupMember", () => new Promise<void>(resolve => { done = resolve; }));
    const { user } = openMembers();
    await user.click(within(rowOf(keyOf(1))).getByTestId("group-remove-member"));
    await user.click(screen.getByTestId("group-remove-confirm"));
    expect(within(rowOf(keyOf(7))).getByTestId("group-remove-member")).toBeDisabled();
    expect(within(rowOf(keyOf(7))).getByTestId("group-make-admin")).toBeDisabled();
    await act(async () => { done(); await Promise.resolve(); });
    expect(within(rowOf(keyOf(7))).getByTestId("group-remove-member")).toBeEnabled();
  });
});

import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { GroupMemberView, GroupView } from "@ghostly/browser/shared/types";
import { GroupMembersDialog } from "../../components/GroupMembersDialog";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: groups.connection, groups.hubs, groups.rename

// A phone never shows a tooltip: what a member's "missing", a hub and Rename mean is said in words on the page.
const ALICE = "alice".padEnd(52, "y"), BOB = "bob".padEnd(52, "y"), ME = "me".padEnd(52, "y");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
const open = (group: GroupView) => {
  fakeEngine.update({ groups: [group] });
  return renderApp(<GroupMembersDialog group={group} onClose={() => {}} />);
};
const row = (key: string) => screen.getAllByTestId("group-member").find(r => r.dataset.key === key)!;

describe("the members panel on a phone", () => {
  it("says a member's missing messages as a whole phrase, not \"2 missing\" next to their name", () => {
    open(groupView({ status: "active", epoch: 2, isAdmin: false, members: [member({ key: ME, me: true }), member({ key: ALICE, nick: "Alice", missing: 1 }), member({ key: BOB, nick: "Bob", missing: 2 })] }));
    expect(within(row(ALICE)).getByTestId("group-member-missing")).toHaveTextContent("1 of their messages has not arrived yet");
    expect(within(row(BOB)).getByTestId("group-member-missing")).toHaveTextContent("2 of their messages have not arrived yet");
    expect(within(row(BOB)).getByTestId("group-member-missing")).not.toHaveAttribute("title");
  });

  it("says once under the list what a hub is, when a member is one", () => {
    const { unmount } = open(groupView({ status: "active", isAdmin: false, members: [member({ key: ME, me: true }), member({ key: ALICE, nick: "Alice", hub: true }), member({ key: BOB, nick: "Bob", hub: true })] }));
    expect(screen.getByTestId("group-hubs-why")).toHaveTextContent("A hub passes the group's messages on to the members it is connected to. It sees who talks when, not what is said.");
    expect(screen.getAllByTestId("group-hubs-why")).toHaveLength(1);
    expect(within(row(ALICE)).getByTestId("group-member-hub")).not.toHaveAttribute("title");
    unmount();
    open(groupView({ status: "active", isAdmin: false, members: [member({ key: ME, me: true }), member({ key: ALICE, nick: "Alice" })] }));
    expect(screen.queryByTestId("group-hubs-why")).not.toBeInTheDocument();
  });

  it("says under the name field, while it is open, who sees the new name", async () => {
    const { user } = open(groupView({ status: "active", isAdmin: true, members: [member({ key: ME, me: true, role: "admin" }), member({ key: ALICE, nick: "Alice" })] }));
    expect(screen.getByTestId("group-rename")).not.toHaveAttribute("title");
    expect(screen.queryByTestId("group-rename-hint")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("group-rename"));
    const hint = "Every member sees the new name. Older apps keep the name they joined with.";
    expect(screen.getByTestId("group-rename-hint")).toHaveTextContent(hint);
    expect(screen.getByTestId("group-rename-input")).toHaveAccessibleDescription(hint);
  });
});

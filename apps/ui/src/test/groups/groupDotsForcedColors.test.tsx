import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { GroupEdgeView, GroupMemberView } from "@ghostly/browser/shared/types";
import { GroupConnection } from "../../components/GroupConnection";
import { GroupMembersDialog } from "../../components/GroupMembersDialog";
import { GroupPaymentComposer } from "../../components/GroupPaymentComposer";
import { groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.accessibility, app.theme, groups.connection

/*
 * Forced colors (Windows Contrast) paint a background with the page's Canvas: a member's dot drawn by its fill alone
 * vanished, and reachable looked like not reachable. Each dot takes system colours and a shape there: filled
 * (Highlight) when reached, a Highlight ring when only some are, a GrayText ring when not. What the browser draws is
 * e2e/web/forced-colors-controls.spec.ts.
 */

const ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y"), BOB = "bob".padEnd(52, "y"), CAROL = "carol".padEnd(52, "y");
const edge = (patch: Partial<GroupEdgeView> = {}): GroupEdgeView => ({ linkId: "edge-1", state: "open", transport: "webrtc/1", lastSeenAt: Date.now(), ...patch });
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: false, missing: 0, ...patch });
const me = member({ key: ME, me: true, online: true });
const alice = member({ key: ALICE, nick: "Alice", online: true, edge: edge({ linkId: "edge-a" }) });
const bob = member({ key: BOB, nick: "Bob", edge: edge({ linkId: "edge-b", state: "waiting", transport: undefined, lastSeenAt: 0 }) });
const carol = member({ key: CAROL, nick: "Carol", edge: edge({ linkId: "edge-c", state: "error", error: "ICE failed" }) });
const mesh = groupView({ status: "active", epoch: 1, members: [me, alice, bob, carol] });

type Look = "reached" | "some" | "not reached";
/** How a dot is drawn in forced colors, read from its classes; an error when it is drawn in none of those ways. */
function forced(dot: Element): Look | string {
  const has = (c: string) => dot.classList.contains(c);
  if (!has("forced-colors:forced-color-adjust-none")) return `left to the browser: ${dot.className}`;
  if (has("forced-colors:bg-[color:Highlight]")) return "reached";
  if (has("forced-colors:border-[color:Highlight]") && has("forced-colors:border-2") && has("forced-colors:bg-[color:Canvas]")) return "some";
  if (has("forced-colors:border-[color:GrayText]") && has("forced-colors:border") && has("forced-colors:bg-[color:Canvas]")) return "not reached";
  return `drawn in no way: ${dot.className}`;
}

describe("a member's reach dot in forced colors", () => {
  it("the members panel: me and a member reached filled, the others a ring", () => {
    const view = renderApp(<GroupMembersDialog group={mesh} onClose={() => {}} />);
    act(() => view.engine.update({ groups: [mesh] }));
    const dots = screen.getAllByTestId("group-member").map(row => within(row).getAllByRole("img")[0]);
    expect(dots.map(d => d.getAttribute("aria-label"))).toEqual(["reachable", "reachable", "not reachable", "not reachable"]);
    expect(dots.map(forced)).toEqual(["reached", "reached", "not reached", "not reached"]);
  });

  it("the members panel of a community: a member behind a hub, and one with no edge", () => {
    const away = (key: string, nick: string, online: boolean) => member({ key, nick, online });
    const members = [me, { ...alice, hub: true, role: "admin" as const }, away(BOB, "Bob", true), away(CAROL, "Carol", false)];
    const community = groupView({ status: "active", epoch: 3, profile: "community", members, community: { hub: false, hubs: 1, connected: 1 } });
    const view = renderApp(<GroupMembersDialog group={community} onClose={() => {}} />);
    act(() => view.engine.update({ groups: [community] }));
    const dots = screen.getAllByTestId("group-member").map(row => within(row).getAllByRole("img")[0]);
    expect(dots.map(d => [d.getAttribute("aria-label"), forced(d)])).toEqual([["reachable", "reached"], ["reachable", "reached"], ["Through a hub", "not reached"], ["Through a hub", "not reached"]]);
  });

  it("the header's dot: filled when everyone is reached, a Highlight ring when some are, a GrayText ring when none", async () => {
    const cases: [GroupMemberView[], Look][] = [[[me, alice], "reached"], [[me, alice, bob], "some"], [[me, bob], "not reached"], [[me, carol], "not reached"]];
    for (const [members, want] of cases) {
      const group = groupView({ status: "active", epoch: 1, members });
      const view = renderApp(<GroupConnection group={group} />);
      act(() => view.engine.update({ groups: [group] }));
      expect(forced(screen.getByTestId("group-connection-dot")), members.map(m => m.nick ?? "me").join(", ")).toBe(want);
      view.unmount();
    }
  });

  it("the connection panel's rows", async () => {
    const view = renderApp(<GroupConnection group={mesh} />);
    act(() => view.engine.update({ groups: [mesh] }));
    await view.user.click(screen.getByTestId("group-connection-options"));
    const rows = screen.getAllByTestId("group-connection-member").map(row => row.querySelector(".rounded-full")!);
    expect(rows.map(forced)).toEqual(["reached", "not reached", "not reached"]);
  });

  it("the group payment's list of members", () => {
    const view = renderApp(<GroupPaymentComposer group={mesh} onClose={() => {}} />);
    act(() => view.engine.update({ groups: [mesh] }));
    const dots = screen.getAllByTestId("group-pay-recipient").map(row => row.querySelector(".rounded-full")!);
    expect(dots.map(forced)).toEqual(["reached", "not reached", "not reached"]);
  });
});

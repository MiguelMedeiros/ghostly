import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { GroupEdgeView, GroupMemberView, GroupView } from "@ghostly/browser/shared/types";
import { GroupConnection } from "../../components/GroupConnection";
import { edgeLabel } from "../../lib/groups";
import { GroupMembersDialog } from "../../components/GroupMembersDialog";
import { groupView, type StatePatch } from "../fakeEngine";
import { renderApp } from "../render";

// covers: groups.connection, transport.indicator

const ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y"), BOB = "bob".padEnd(52, "y"), CAROL = "carol".padEnd(52, "y");
const NOW = Date.now();
const edge = (patch: Partial<GroupEdgeView> = {}): GroupEdgeView => ({ linkId: "edge-1", state: "open", transport: "webrtc/1", lastSeenAt: NOW, ...patch });
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: false, missing: 0, ...patch });
const me = member({ key: ME, me: true, online: true });
const alice = (e?: Partial<GroupEdgeView>) => member({ key: ALICE, nick: "Alice", role: "admin", online: e?.state === undefined || e.state === "open", edge: edge({ linkId: "edge-a", ...e }) });
const bob = (e?: Partial<GroupEdgeView>) => member({ key: BOB, nick: "Bob", online: e?.state === undefined || e.state === "open", edge: edge({ linkId: "edge-b", ...e }) });
const active = (members: GroupMemberView[]) => groupView({ status: "active", epoch: 1, members });

function render(group: GroupView, state: StatePatch = {}) {
  const view = renderApp(<GroupConnection group={group} />);
  act(() => view.engine.update({ groups: [group], ...state }));
  return view;
}
/** Renders it with the popover open, as a click on the header leaves it. */
async function open(group: GroupView, state: StatePatch = {}) {
  const view = render(group, state);
  await view.user.click(screen.getByTestId("group-connection-options"));
  return view;
}

/** What the header says, in the three places it says it. */
function header() {
  const trigger = screen.getByTestId("group-connection-options");
  return {
    kind: trigger.dataset.state,
    name: trigger.getAttribute("aria-label")!.replace("Group connection: ", ""),
    popover: screen.getByTestId("group-connection-state").textContent,
    // The label, without the line on what carries the group.
    tooltip: screen.getByTestId("group-connection-tooltip").textContent!.replace(screen.queryByTestId("group-connection-tooltip-detail")?.textContent ?? "", ""),
    dot: [...(within(trigger).queryByTestId("group-connection-dot")?.classList ?? [])].find(c => c.startsWith("bg-")) ?? null,
  };
}
const rows = () => screen.getAllByTestId("group-connection-member").map(row => ({
  key: row.dataset.key, state: row.dataset.state, status: within(row).getByTestId("group-connection-member-status").textContent,
}));

describe("GroupConnection: over what the group is live", () => {
  it.each<[string, GroupMemberView[], string | undefined, string | undefined]>([
    ["everyone over WebRTC", [me, alice(), bob()], "2 of 2 live over WebRTC", "webrtc/1"],
    ["some over WebRTC", [me, alice(), bob({ state: "waiting", transport: undefined })], "1 of 2 live over WebRTC", "webrtc/1"],
    ["edges over different transports", [me, alice(), bob({ transport: "iroh/1" }), member({ key: CAROL, edge: edge({ linkId: "edge-c", transport: "iroh/1" }) })], "3 of 3 live · 2 Iroh, 1 WebRTC", undefined],
    ["nobody live", [me, alice({ state: "waiting" }), bob({ state: "waiting" })], undefined, undefined],
  ])("%s", async (_, members, line, transport) => {
    await open(active(members));
    const trigger = screen.getByTestId("group-connection-options");
    if (line) {
      expect(screen.getByTestId("group-connection-tooltip-detail")).toHaveTextContent(line);
      expect(screen.getByTestId("group-connection-transports")).toHaveTextContent(line);
    } else expect(screen.queryByTestId("group-connection-transports")).not.toBeInTheDocument();
    if (transport) {
      expect(trigger).toHaveAttribute("data-transport", transport);
      expect(trigger.querySelector("[data-transport-icon]")).toHaveAttribute("data-transport-icon", transport);
    } else expect(trigger).not.toHaveAttribute("data-transport");
  });
});

describe("GroupConnection: the header sums up the mesh", () => {
  it.each<[string, GroupMemberView[], StatePatch, { kind: string; label: string; dot: string | null }]>([
    ["every other member reachable", [me, alice(), bob()], {}, { kind: "connected", label: "2 of 2 reachable", dot: "bg-accent" }],
    ["some reachable, not all", [me, alice(), bob({ state: "waiting", transport: undefined, lastSeenAt: 0 })], {}, { kind: "partial", label: "1 of 2 reachable", dot: "bg-amber-500" }],
    ["nobody reachable, one edge failed", [me, alice({ state: "error", error: "ICE failed" }), bob({ state: "waiting" })], {}, { kind: "failure", label: "Nobody reachable", dot: "bg-danger" }],
    ["nobody reachable yet, one connecting", [me, alice({ state: "connecting" }), bob({ state: "waiting" })], {}, { kind: "waiting", label: "Connecting to members…", dot: "bg-text-muted" }],
    ["nobody reachable, nobody around", [me, alice({ state: "waiting" }), bob({ state: "waiting" })], {}, { kind: "waiting", label: "Nobody reachable", dot: "bg-text-muted" }],
    ["alone in the group", [me], {}, { kind: "waiting", label: "Only you so far", dot: "bg-text-muted" }],
    ["this device offline", [me, alice(), bob()], { settings: { online: false } }, { kind: "offline", label: "Offline", dot: null }],
  ])("%s", async (_, members, state, want) => {
    await open(active(members), state);
    expect(header()).toEqual({ kind: want.kind, name: want.label, popover: want.label, tooltip: want.label, dot: want.dot });
  });
});

describe("GroupConnection: the popover lists every member's edge", () => {
  it("names each member with what carries their edge, or since when they are away; never me", async () => {
    await open(active([me, alice(), bob({ state: "waiting", transport: undefined, lastSeenAt: NOW - 5 * 60_000 }),
      member({ key: CAROL, nick: "Carol", edge: edge({ linkId: "edge-c", state: "error", transport: undefined, lastSeenAt: 0, error: "The member's key did not match" }) }),
      member({ key: "dave".padEnd(52, "y"), nick: "Dave" })]));
    expect(rows()).toEqual([
      { key: ALICE, state: "open", status: "Connected · WebRTC" },
      { key: BOB, state: "waiting", status: "Not reachable · last seen 5 min ago" },
      { key: CAROL, state: "error", status: "Connection issue · not seen yet" },
      { key: "dave".padEnd(52, "y"), state: "none", status: "No connection yet" },
    ]);
    // A failure says why, where it happened.
    expect(within(screen.getAllByTestId("group-connection-member")[2]).getByText("The member's key did not match")).toBeInTheDocument();
    // Honest about transports: edges are WebRTC only.
    expect(screen.getByTestId("group-connection-note")).toHaveTextContent("Iroh, HyperDHT and DHT-only delivery are not offered in groups yet");
  });

  it("follows the group it is handed: a member coming back turns reachable, one going away turns the header partial", async () => {
    const view = await open(active([me, alice(), bob({ state: "waiting", lastSeenAt: 0 })]));
    expect(header().kind).toBe("partial");
    view.rerender(<GroupConnection group={active([me, alice(), bob()])} />);
    expect(header()).toMatchObject({ kind: "connected", name: "2 of 2 reachable" });
    view.rerender(<GroupConnection group={active([me, alice({ state: "waiting", lastSeenAt: NOW - 30_000 }), bob()])} />);
    expect(header()).toMatchObject({ kind: "partial", name: "1 of 2 reachable" });
    expect(rows()[0]).toMatchObject({ key: ALICE, status: "Not reachable · last seen just now" });
    expect(edgeLabel(me)).toBe("You");
  });

  it("opens from the header and closes on Escape, handing focus back", async () => {
    const { user } = render(active([me, alice()]));
    const trigger = screen.getByTestId("group-connection-options");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog", { name: "Group connection" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("group-connection-options")).toHaveFocus();
  });

  it("reconnects an edge that is down, and says so when that fails", async () => {
    const { user, engine } = await open(active([me, alice(), bob({ state: "waiting" })]));
    engine.on("connect", () => { throw new Error("You are offline. Go online before reconnecting."); });
    // Only the member who is down can be reconnected.
    expect(screen.getAllByTestId("group-connection-reconnect")).toHaveLength(1);
    await user.click(screen.getByTestId("group-connection-reconnect"));
    expect(engine.callsTo("connect")).toEqual([{ linkId: "edge-b" }]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Go online before reconnecting");
  });

  it("offers no Reconnect while this device is offline", async () => {
    await open(active([me, alice({ state: "waiting" })]), { settings: { online: false } });
    expect(screen.queryByTestId("group-connection-reconnect")).not.toBeInTheDocument();
  });
});

describe("GroupMembersDialog: each member says how their edge is", () => {
  it("shows the edge's state under every other member's name", () => {
    const group = active([me, alice(), bob({ state: "waiting", lastSeenAt: 0 })]);
    const view = renderApp(<GroupMembersDialog group={group} onClose={() => {}} />);
    act(() => view.engine.update({ groups: [group] }));
    const statuses = screen.getAllByTestId("group-member-status").map(s => s.textContent);
    expect(statuses).toEqual(["Connected · WebRTC", "Not reachable · not seen yet"]);
  });
});

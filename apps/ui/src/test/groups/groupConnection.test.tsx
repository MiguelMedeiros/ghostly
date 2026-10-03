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
    // An app with no transport for a group's links (no WebRTC, no native transport). Not "Connecting…" forever.
    ["an app with no transport for group links", [me, alice({ state: "connecting" }), bob({ state: "waiting" })], { transport: { protocol: "webrtc/1", relays: [], webrtc: false, groupLinks: false } }, { kind: "failure", label: "Groups can't connect from this app yet", dot: "bg-danger" }],
    ["an app with no transport for group links, alone in the group", [me], { transport: { protocol: "webrtc/1", relays: [], webrtc: false, groupLinks: false } }, { kind: "waiting", label: "Only you so far", dot: "bg-text-muted" }],
    // Ghostly Desktop on Linux: no WebRTC, but Iroh and HyperDHT carry its group links (WISP 9xx § Transports).
    ["an app with no WebRTC but native transports", [me, alice({ state: "connecting" }), bob({ state: "waiting" })], { transport: { protocol: "webrtc/1", relays: [], webrtc: false } }, { kind: "waiting", label: "Connecting to members…", dot: "bg-text-muted" }],
    // A group past 16 members runs on hubs: a member reached through one is reachable, as the header line counts it.
    ["a member reached through a hub", [me, alice(), member({ key: BOB, nick: "Bob", online: true, viaHub: true, edge: edge({ linkId: "edge-b", state: "waiting", lastSeenAt: 0 }) })], {}, { kind: "connected", label: "2 of 2 reachable", dot: "bg-accent" }],
    ["only members reached through a hub", [me, member({ key: ALICE, online: true, viaHub: true }), member({ key: BOB, online: true, viaHub: true })], {}, { kind: "connected", label: "2 of 2 reachable", dot: "bg-accent" }],
    ["an app with no WebRTC, a member live over Iroh", [me, alice({ transport: "iroh/1" }), bob({ transport: "iroh/1" })], { transport: { protocol: "webrtc/1", relays: [], webrtc: false } }, { kind: "connected", label: "2 of 2 reachable", dot: "bg-accent" }],
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
    // Honest about transports: WebRTC, and Iroh or HyperDHT with a member that has no WebRTC; no DHT-only delivery.
    expect(screen.getByTestId("group-connection-note")).toHaveTextContent("DHT-only delivery is not offered in groups yet");
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

  it("offers no Reconnect for a member reached through a hub", async () => {
    await open(active([me, alice({ state: "waiting", lastSeenAt: 0 }), member({ key: BOB, nick: "Bob", online: true, viaHub: true, edge: edge({ linkId: "edge-b", state: "waiting", lastSeenAt: 0 }) })]));
    expect(rows()[1]).toMatchObject({ key: BOB, status: "Through a hub" });
    // Only Alice, who is really down, can be reconnected.
    expect(screen.getAllByTestId("group-connection-reconnect")).toHaveLength(1);
    expect(within(screen.getAllByTestId("group-connection-member")[0]).getByTestId("group-connection-reconnect")).toBeInTheDocument();
  });

  it("a member this device has no free native connection for says it waits for one", async () => {
    // Ghostly Desktop on Linux: its group links go over Iroh or HyperDHT, a few listeners shared with 1:1 chats.
    await open(active([me, alice({ transport: "iroh/1" }), bob({ state: "waiting", transport: undefined, noSlot: true })]), { transport: { protocol: "webrtc/1", relays: [], webrtc: false } });
    expect(rows()[1]).toMatchObject({ key: BOB, status: "Waiting for a free connection on this device" });
  });

  it("an app with no transport for group links says why no member is reachable, and offers no Reconnect that cannot help", async () => {
    await open(active([me, alice({ state: "connecting" }), bob({ state: "waiting" })]), { transport: { protocol: "webrtc/1", relays: [], webrtc: false, groupLinks: false } });
    expect(screen.getByTestId("group-connection-no-webrtc")).toHaveTextContent("this app has neither");
    expect(screen.queryByTestId("group-connection-reconnect")).not.toBeInTheDocument();
  });

  it("offers no Reconnect while this device is offline", async () => {
    await open(active([me, alice({ state: "waiting" })]), { settings: { online: false } });
    expect(screen.queryByTestId("group-connection-reconnect")).not.toBeInTheDocument();
  });
});

describe("GroupConnection: a community is connected through its hubs", () => {
  const DAVE = "dave".padEnd(52, "y");
  // As the engine hands a community: an edge only for the hub my app is linked to; nothing says the others are online.
  const away = (key: string, nick: string) => member({ key, nick });
  const community = (members: GroupMemberView[], hub = false) => groupView({ status: "active", epoch: 3, profile: "community", members, community: { hub, hubs: 1, connected: members.filter(m => m.edge?.state === "open").length } });

  it.each<[string, GroupMemberView[], { kind: string; label: string; dot: string | null }]>([
    // Counted per member, twelve people on one hub read "1 of 11 reachable" with a warning dot while everything worked.
    ["an edge up to a hub: connected, whatever the number of members", [me, alice(), away(BOB, "Bob"), away(CAROL, "Carol"), away(DAVE, "Dave")], { kind: "connected", label: "Connected to the group", dot: "bg-accent" }],
    ["the hub's edge not up yet: connecting, not a failure", [me, alice({ state: "waiting", transport: undefined }), away(BOB, "Bob")], { kind: "waiting", label: "Connecting to the group…", dot: "bg-text-muted" }],
    ["the hub's edge failed", [me, alice({ state: "error", error: "ICE failed" }), away(BOB, "Bob")], { kind: "failure", label: "Nobody reachable", dot: "bg-danger" }],
    ["no edge at all (every other app is closed)", [me, away(ALICE, "Alice"), away(BOB, "Bob")], { kind: "waiting", label: "Nobody reachable", dot: "bg-text-muted" }],
  ])("%s", async (_, members, want) => {
    await open(community(members));
    expect(header()).toEqual({ kind: want.kind, name: want.label, popover: want.label, tooltip: want.label, dot: want.dot });
  });

  it("lists the edges my app holds, counts them alone, and says the rest go through the hubs", async () => {
    await open(community([me, alice(), away(BOB, "Bob"), away(CAROL, "Carol")]));
    expect(rows()).toEqual([{ key: ALICE, state: "open", status: "Connected · WebRTC" }]);
    expect(screen.getByTestId("group-connection-transports")).toHaveTextContent("1 of 1 live over WebRTC");
    expect(screen.getByTestId("group-connection-note")).toHaveTextContent("the hubs pass every message on to everyone");
    expect(screen.getByTestId("group-connection-note")).not.toHaveTextContent("direct");
  });

  it("the members panel does not call a member behind a hub not reachable", () => {
    const group = community([me, alice(), away(BOB, "Bob")]);
    const view = renderApp(<GroupMembersDialog group={group} onClose={() => {}} />);
    act(() => view.engine.update({ groups: [group] }));
    expect(screen.getAllByTestId("group-member-status").map(s => s.textContent)).toEqual(["Connected · WebRTC", "Through a hub"]);
    const dots = screen.getAllByTestId("group-member").map(row => within(row).getAllByRole("img")[0].getAttribute("aria-label"));
    expect(dots).toEqual(["reachable", "reachable", "Through a hub"]);
  });

  it("the members panel says a hub my edge to is not up is reached through the one that is", () => {
    // Two hubs: the edge to Alice is up, the one to Bob is not (it never opened, or it dropped). Bob's messages come through Alice.
    for (const state of ["waiting", "error", "connecting"] as const) {
      const group = community([me, alice(), bob({ state, transport: undefined, lastSeenAt: 0 })]);
      const view = renderApp(<GroupMembersDialog group={group} onClose={() => {}} />);
      act(() => view.engine.update({ groups: [group] }));
      expect(screen.getAllByTestId("group-member-status").map(s => s.textContent)).toEqual(["Connected · WebRTC", "Through a hub"]);
      view.unmount();
    }
  });

  it("the members panel keeps each edge's own state while no edge is up", () => {
    const group = community([me, alice({ state: "waiting", transport: undefined, lastSeenAt: 0 }), away(BOB, "Bob")]);
    const view = renderApp(<GroupMembersDialog group={group} onClose={() => {}} />);
    act(() => view.engine.update({ groups: [group] }));
    expect(screen.getAllByTestId("group-member-status").map(s => s.textContent)).toEqual(["Not reachable · not seen yet", "Through a hub"]);
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

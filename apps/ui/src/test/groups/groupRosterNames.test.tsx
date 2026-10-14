import { act, screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { GroupMemberView, GroupView, StoredMessage } from "@ghostly/browser/shared/types";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: groups.mentions, groups.member-colors

// How often a member's name is worked out: the page's cost of a large roster.
const names = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../lib/groups", async original => {
  const actual = await original<typeof import("../../lib/groups")>();
  const memberName: typeof actual.memberName = (m, t) => { names.count++; return actual.memberName(m, t); };
  return { ...actual, memberName };
});

const ME = "me".padEnd(52, "y");
const keyOf = (i: number) => `m${i}`.padEnd(52, "y");
const MEMBERS = 40, MESSAGES = 300;
const roster = (): GroupMemberView[] => [
  { key: ME, role: "member", me: true, online: true, missing: 0 },
  ...Array.from({ length: MEMBERS - 1 }, (_, i): GroupMemberView => ({ key: keyOf(i), role: i ? "member" : "admin", me: false, online: true, missing: 0, nick: `Member ${i}` })),
];
/** The group as each of the engine's states carries it: the same roster, in new objects. */
const community = (patch: Partial<GroupView> = {}) => groupView({ profile: "community", status: "active", epoch: 1, members: roster(), ...patch });
const history = (): StoredMessage[] => Array.from({ length: MESSAGES }, (_, i): StoredMessage => ({
  linkId: "group:group-1", id: `g${i}`, text: `message ${i}`, sender: "peer", member: keyOf(i % (MEMBERS - 1)), timestamp: 1_700_000_000_000 + i, via: "datalink" }));

async function openGroup(messages = history()) {
  fakeEngine.on("groupMessages", () => messages).on("updateSettings", () => undefined).on("setGroupTyping", () => undefined);
  fakeEngine.update({ groups: [community()] });
  renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
  await screen.findByText(`message ${MESSAGES - 1}`);
}

/** How many names the page works out for one state of the engine. */
function namesFor(update: () => void): number {
  names.count = 0;
  act(update);
  return names.count;
}

describe("GroupChat: a large roster", () => {
  it("a state that changes nothing in the group names no member again for its history", async () => {
    await openGroup();
    // Something else changed (an edge came up): the group is the same, in a new object, as every state brings it.
    const count = namesFor(() => fakeEngine.update({ groups: [community()], links: [linkView({ id: "link-other", peerPubKeyZ32: "otherpeer" })] }));
    // Before, each message built the roster's names again: 300 messages × 40 members on every state.
    expect(count).toBeLessThan(MESSAGES);
  });

  it("a member's new name is over their messages at once", async () => {
    await openGroup();
    const lastNick = () => screen.getAllByTestId("message-nick").slice(-1)[0];
    expect(lastNick()).toHaveTextContent("Member");
    const members = roster().map(m => m.key === keyOf((MESSAGES - 1) % (MEMBERS - 1)) ? { ...m, nick: "Renamed" } : m);
    act(() => fakeEngine.update({ groups: [community({ members })] }));
    expect(lastNick()).toHaveTextContent("Renamed");
  });

  it("a mention reads by the member's name of now, and a writer who left goes by the name the group knew", async () => {
    const gone = "gone".padEnd(52, "y");
    const mention: StoredMessage = { linkId: "group:group-1", id: "gm", text: "ping @Old now", sender: "peer", member: gone, timestamp: 1_700_000_100_000, via: "datalink",
      mentions: [{ k: keyOf(1), o: 5, l: 4 }] };
    await openGroup([...history().slice(0, -1), mention, ...history().slice(-1).map(m => ({ ...m, timestamp: m.timestamp + 200_000 }))]);
    act(() => fakeEngine.update({ groups: [community({ formerNames: { [gone]: "Zed" } })] }));
    const row = screen.getByText(/ping/).closest<HTMLElement>("[data-message-row]")!;
    expect(row).toHaveTextContent("Zed");
    expect(row).toHaveTextContent("ping @Member 1 now");
  });
});

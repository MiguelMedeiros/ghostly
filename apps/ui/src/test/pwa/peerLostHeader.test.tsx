import { act, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { GroupEdgeView, GroupMemberView, LinkView } from "@ghostly/browser/shared/types";
import { engine } from "@ghostly/browser/platform/engine";
import { ChatConnection } from "../../components/ChatConnection";
import { GroupConnection } from "../../components/GroupConnection";
import { PeerAvatar } from "../../components/Avatar";
import { PeerPresenceLine } from "../../components/PresenceMarks";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";
// covers: extension.reconnecting

/**
 * An extension tab whose peer went away and did not come back at once (the Reconnecting notice): what the page holds
 * is the last state it was told. The header said "Connected · WebRTC", with the contact's green dot, beside the notice
 * that nothing new arrives; it says the chat is on its way until the peer is back.
 */
afterEach(async () => {
  fakeEngine.refuse = null;
  await engine.connect();
});

const PEER = "peer".padEnd(52, "p");
type Pairing = NonNullable<LinkView["pairing"]>;

/** The peer goes and its tries to start again fail, until `back`. */
async function losePeer() {
  fakeEngine.refuse = new Error("The offscreen document did not start");
  act(() => fakeEngine.drop());
  await waitFor(() => expect(engine.reconnecting).toBe(true), { timeout: 3000 });
}
async function back() {
  fakeEngine.refuse = null;
  await waitFor(() => expect(engine.reconnecting).toBe(false), { timeout: 3000 });
}

describe("the header while the tab lost its peer", () => {
  it("says a live chat is connecting, not connected, and its contact's dot goes until the peer is back", async () => {
    const view = renderApp(<div data-testid="header">
      <PeerAvatar peerPubKey={PEER} label="Ana" testId="chat-avatar" presence />
      <PeerPresenceLine peerKey={PEER} testId="chat-presence" />
      <ChatConnection peerKey={PEER} />
    </div>);
    act(() => view.engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", peerPresence: "active", pairing: { status: "ready", transport: "webrtc/1" } as Pairing })] }));
    const trigger = screen.getByTestId("connection-options");
    expect(trigger).toHaveAttribute("data-state", "connected");
    expect(trigger).toHaveAttribute("aria-label", "Connection options: Connected · WebRTC");
    expect(screen.getByTestId("chat-avatar-presence")).toHaveAttribute("data-tone", "online");
    expect(screen.getByTestId("chat-presence-presence")).toHaveTextContent("Online");

    await losePeer();
    expect(trigger).toHaveAttribute("data-state", "waiting");
    expect(trigger).not.toHaveAttribute("data-transport");
    expect(trigger).toHaveAttribute("aria-label", "Connection options: Connecting…");
    expect(screen.getByTestId("connection-state")).toHaveTextContent("Connecting…");
    expect(within(trigger).getByTestId("connection-dot")).toHaveClass("bg-text-muted", "motion-safe:animate-pulse");
    expect(screen.queryByText("Connected · WebRTC")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-avatar-presence")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-presence-presence")).not.toBeInTheDocument();
    // Nothing dials while the peer is gone: no Reconnect to press.
    expect(screen.queryByTestId("connection-reconnect")).not.toBeInTheDocument();

    await back();
    expect(trigger).toHaveAttribute("data-state", "connected");
    expect(trigger).toHaveAttribute("aria-label", "Connection options: Connected · WebRTC");
    expect(screen.getByTestId("chat-avatar-presence")).toHaveAttribute("data-tone", "online");
  });

  it("says a failed chat is connecting, not a connection issue", async () => {
    const view = renderApp(<ChatConnection peerKey={PEER} />);
    act(() => view.engine.update({ links: [linkView({ peerPubKeyZ32: PEER, dataLink: "idle", pairing: { status: "error", error: "Relay refused" } as Pairing })] }));
    expect(screen.getByTestId("connection-options")).toHaveAttribute("data-state", "failure");
    await losePeer();
    expect(screen.getByTestId("connection-options")).toHaveAttribute("data-state", "waiting");
    expect(screen.getByTestId("connection-options")).toHaveAttribute("aria-label", "Connection options: Connecting…");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says a group is connecting, not who is reachable, until the peer is back", async () => {
    const edge: GroupEdgeView = { linkId: "edge-a", state: "open", transport: "webrtc/1", lastSeenAt: Date.now() };
    const members: GroupMemberView[] = [
      { key: "me".padEnd(52, "y"), role: "member", me: true, online: true, missing: 0 },
      { key: "alice".padEnd(52, "y"), nick: "Alice", role: "admin", me: false, online: true, missing: 0, edge },
    ];
    const group = groupView({ status: "active", epoch: 1, members });
    const view = renderApp(<GroupConnection group={group} />);
    act(() => view.engine.update({ groups: [group] }));
    const trigger = screen.getByTestId("group-connection-options");
    expect(trigger).toHaveAttribute("data-state", "connected");
    expect(trigger).toHaveAttribute("data-transport", "webrtc/1");

    await losePeer();
    expect(trigger).toHaveAttribute("data-state", "waiting");
    expect(trigger).not.toHaveAttribute("data-transport");
    expect(trigger).toHaveAttribute("aria-label", "Group connection: Connecting…");
    expect(within(trigger).getByTestId("group-connection-dot")).toHaveClass("bg-text-muted", "motion-safe:animate-pulse");

    await back();
    expect(trigger).toHaveAttribute("data-state", "connected");
    expect(trigger).toHaveAttribute("aria-label", "Group connection: 1 of 1 reachable");
  });

  // The line under the group's name said "3 members · 2 of 2 reachable" (a community "· your app relays for others")
  // beside the icon's Connecting… (bug hunt, 2026-11-13).
  for (const [kind, patch, said] of [
    ["private group", {}, "3 members · 2 of 2 reachable"],
    ["community hub", { profile: "community", community: { hub: true, hubs: 1, connected: 2 } }, "3 members · your app relays for others"],
  ] as const) it(`says under a ${kind}'s name that it is connecting, not who is reachable`, async () => {
    const member = (key: string, nick: string): GroupMemberView => ({ key: key.padEnd(52, "y"), nick, role: "member", me: false, online: true, missing: 0 });
    const group = groupView({ status: "active", epoch: 1, members: [{ ...member("me", ""), me: true }, member("alice", "Alice"), member("bob", "Bob")], ...patch });
    fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined);
    fakeEngine.update({ groups: [group] });
    renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
    expect(await screen.findByTestId("group-members")).toHaveTextContent(said);

    await losePeer();
    expect(screen.getByTestId("group-members")).toHaveTextContent("3 members · connecting…");
    expect(screen.getByTestId("group-members")).not.toHaveTextContent(said);

    await back();
    expect(screen.getByTestId("group-members")).toHaveTextContent(said);
  });
});

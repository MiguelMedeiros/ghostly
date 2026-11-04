// The engine sends its whole state anew on every change (up to 20 a second while a file moves). An open group draws
// again only when what it shows changes, as a 1:1 chat does (chatStateRedraw.test.tsx): a state that changes nothing of
// it draws neither its page nor its header's connection.
import { Profiler } from "react";
import { act, screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { GroupMemberView, StoredMessage } from "@ghostly/browser/shared/types";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: groups.send

const ME = "me".padEnd(52, "y"), ANA = "ana".padEnd(52, "y"), BO = "bo".padEnd(52, "y");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
const stored = (i: number): StoredMessage =>
  ({ linkId: "group:group-1", id: `g${i}`, text: `Message ${i}`, sender: "peer", member: i % 2 ? ANA : BO, timestamp: 1_700_000_000_000 + i * 60_000, via: "datalink" });
/** The group, its contact's link and another chat's, each a new object as every state of the engine brings them. */
const state = (patch: { nick?: string; transfer?: number } = {}) => ({
  groups: [groupView({ status: "active", epoch: 1, memberLinks: { "link-ana": ANA },
    members: [member({ key: ME, me: true }), member({ key: ANA, nick: patch.nick ?? "Ana" }), member({ key: BO, nick: "Bo" })] })],
  links: [linkView({ id: "link-ana", peerPubKeyZ32: ANA, profile: "paired-chat/1" } as never), linkView({ id: "link-cy", peerPubKeyZ32: "cy".padEnd(52, "y"), profile: "paired-chat/1" } as never)],
  ...(patch.transfer !== undefined && { transfers: { [`t${patch.transfer}`]: { bytes: patch.transfer } } }),
});

describe("an engine state that changes nothing of an open group", () => {
  it("draws neither its page nor its header", async () => {
    const history = Array.from({ length: 40 }, (_, i) => stored(i));
    fakeEngine.on("groupMessages", () => history).on("updateSettings", () => undefined).on("setGroupTyping", () => undefined).update(state() as never);
    let draws = 0;
    renderApp(
      <Profiler id="group" onRender={() => { draws++; }}>
        <Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>
      </Profiler>,
      { route: "/group/group-1" },
    );
    await screen.findByText("Message 39");
    await act(() => new Promise<void>((done) => setTimeout(done, 300)));

    expect(document.body.textContent).not.toContain("Ana Lima");
    draws = 0;
    for (let i = 0; i < 20; i++) act(() => fakeEngine.update(state({ transfer: i }) as never));
    expect(draws).toBe(0);

    // A member's name changing still draws it, and the rows say the new name.
    act(() => fakeEngine.update(state({ nick: "Ana Lima" }) as never));
    expect(draws).toBeGreaterThan(0);
    expect(document.body.textContent).toContain("Ana Lima");
  });
});

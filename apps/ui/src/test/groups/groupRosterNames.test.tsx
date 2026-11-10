// An open group names its members who are contacts as their chats do (a nickname given there wins over an identity).
// Each look through the stored chats walks every key of the page's storage, and the roster is named again at each
// message in the group (the group's state carries when it last had one): one look for the whole roster, not one per
// member who is a contact.
import { act, screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ChatSession } from "../../lib/types";
import type { GroupMemberView } from "@ghostly/browser/shared/types";
import { GroupChat } from "../../pages/GroupChat";
import { saveSession } from "../../lib/storage";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: groups.send

const ME = "me".padEnd(52, "y");
const peer = (i: number) => `peer${i}`.padEnd(52, "y");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
const MEMBERS = 30;
const state = (lastMessageAt: number) => ({
  groups: [groupView({
    status: "active", epoch: 1, lastMessageAt,
    memberLinks: Object.fromEntries(Array.from({ length: MEMBERS }, (_, i) => [`link-${i}`, peer(i)])),
    members: [member({ key: ME, me: true }), ...Array.from({ length: MEMBERS }, (_, i) => member({ key: peer(i), nick: `Member ${i}` }))],
  })],
  links: Array.from({ length: MEMBERS }, (_, i) => linkView({ id: `link-${i}`, peerPubKeyZ32: peer(i), profile: "paired-chat/1" } as never)),
});

describe("an open group whose members are contacts", () => {
  it("looks through the stored chats once at a message in the group, not once per member", async () => {
    for (let i = 0; i < MEMBERS; i++) {
      saveSession({ id: `chat${i}`, mySeedB64: "s", peerPubKeyB64: peer(i), encKeyB64: "e", createdAt: 1, messages: [], ...(i === 0 && { label: "Mom" }) } as unknown as ChatSession);
    }
    fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined).on("setGroupTyping", () => undefined).update(state(1) as never);
    renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
    await screen.findByText("Friends");
    await act(() => new Promise<void>((done) => setTimeout(done, 300)));

    const real = localStorage;
    let walked = 0;
    vi.stubGlobal("localStorage", {
      get length() { return real.length; },
      key: (i: number) => { walked++; return real.key(i); },
      getItem: (key: string) => real.getItem(key),
      setItem: (key: string, value: string) => real.setItem(key, value),
      removeItem: (key: string) => real.removeItem(key),
      clear: () => real.clear(),
    });
    try {
      act(() => fakeEngine.update(state(2) as never));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(walked).toBeLessThanOrEqual(2 * real.length);
  });
});

import { screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GroupMemberView, StoredMessage } from "@ghostly/browser/shared/types";
import { GroupChat } from "../../pages/GroupChat";
import { setStorageProfile as setProfile } from "../../lib/storage";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: groups.reactions, groups.pins

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

/**
 * A reaction or a pin the engine refuses in a private group ("You are not in this group", a community's "Only the admin
 * pins"): the page said nothing, so no chip, no pin, and no word why. The refusal is said in the group's notice.
 */
const REFUSED = "You are not in this group";
const ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y");
const HERS = `${ALICE}:1:0`;
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
const hers: StoredMessage = { linkId: "group:group-1", id: HERS, text: "lunch at noon?", sender: "peer", senderKey: ALICE, timestamp: 1_700_000_000_000, via: "datalink" } as StoredMessage;

function openGroup(pinned = false) {
  fakeEngine.on("groupMessages", () => [hers]).on("updateSettings", () => undefined);
  fakeEngine.update({ groups: [groupView({ status: "active", epoch: 1, myKey: ME, members: [member({ key: ME, me: true }), member({ key: ALICE, nick: "Alice" })],
    ...(pinned && { pin: { id: HERS, by: ALICE, at: 1_700_000_000_500, messageId: HERS } }) })] } as never);
  return renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
}

const notice = () => screen.findByTestId("group-notice");

afterEach(() => { localStorage.clear(); setProfile(""); });

describe("a reaction or a pin the engine refuses in a private group", () => {
  it("a refused reaction says why", async () => {
    const { user, engine } = openGroup();
    engine.on("react", () => ({ error: REFUSED, refused: true }));
    const bubble = (await screen.findByText("lunch at noon?")).closest<HTMLElement>("[data-message-id]")!;
    await user.click(within(bubble).getByTestId("message-react-action"));
    await user.click(screen.getAllByTestId("reaction-quick")[0]);
    expect(await notice()).toHaveTextContent(REFUSED);
    expect(engine.callsTo("react")).toEqual([{ linkId: "group:group-1", messageId: HERS, emoji: "👍" }]);
  });

  it("a reaction that fails says why, and one taken next clears it", async () => {
    const { user, engine } = openGroup();
    engine.on("react", () => { throw new Error(REFUSED); });
    const bubble = (await screen.findByText("lunch at noon?")).closest<HTMLElement>("[data-message-id]")!;
    await user.click(within(bubble).getByTestId("message-react-action"));
    await user.click(screen.getAllByTestId("reaction-quick")[0]);
    expect(await notice()).toHaveTextContent(REFUSED);
    engine.on("react", () => ({ error: null }));
    await user.click(within(bubble).getByTestId("message-react-action"));
    await user.click(screen.getAllByTestId("reaction-quick")[1]);
    await waitFor(() => expect(screen.queryByTestId("group-notice")).not.toBeInTheDocument());
  });

  it("a refused pin from ⋮ says why", async () => {
    const { user, engine } = openGroup();
    engine.on("pinMessage", () => ({ error: REFUSED, refused: true }));
    const bubble = (await screen.findByText("lunch at noon?")).closest<HTMLElement>("[data-message-id]")!;
    await user.click(within(bubble).getByTestId("message-options"));
    await user.click(screen.getByTestId("message-pin"));
    expect(await notice()).toHaveTextContent(REFUSED);
    expect(engine.callsTo("pinMessage")).toEqual([{ linkId: "group:group-1", messageId: HERS, remove: false }]);
  });

  it("a refused unpin from the pinned bar's ✕ says why", async () => {
    const { user, engine } = openGroup(true);
    engine.on("pinMessage", () => ({ error: REFUSED, refused: true }));
    await user.click(await screen.findByTestId("pinned-unpin"));
    expect(await notice()).toHaveTextContent(REFUSED);
    expect(engine.callsTo("pinMessage")).toEqual([{ linkId: "group:group-1", remove: true }]);
  });
});

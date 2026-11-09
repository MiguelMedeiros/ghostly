import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes, useNavigate } from "react-router-dom";
import { MESSAGE_CHANGES_TICK_MS } from "@ghostly/browser/platform/engine";
import type { GroupMemberView, StoredMessage } from "@ghostly/browser/shared/types";
import { peekShareFor, receiveShare, resetIncomingShare, sendShareTo, type IncomingShare } from "../../lib/incomingShare";
import { saveSession } from "../../lib/storage";
import { Chat } from "../../pages/Chat";
import { GroupChat } from "../../pages/GroupChat";
import { SharePicker } from "../../pages/SharePicker";
import { SEARCH_STATUS_SETTLE_MS } from "../../components/ui/SearchStatus";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.pwa.share-target, chat.edit, groups.edit

/*
 * A share from another app goes to the Share to… picker first (#/shared), and the chat's page goes while it shows:
 * back on the chat, one of my messages edited there before is still being edited, with the words typed into it, and
 * the share waits for that edit to end (saved or left) to go in the draft.
 */

vi.unmock("@ghostly/browser/platform/sync");
vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

const PEER = "peer".padEnd(52, "p"), LINK = "link-heron";
const WIRE = "M".repeat(22);
const mine: StoredMessage = { linkId: LINK, id: `me_${WIRE}`, wireId: WIRE, text: "heron note 8812", sender: "me", timestamp: Date.now() - 60_000, delivery: "delivered", via: "datalink" };
const hello: StoredMessage = { linkId: LINK, id: `peer_${"H".repeat(22)}`, text: "hello there", sender: "peer", timestamp: Date.now() - 120_000, via: "datalink" };
const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, MESSAGE_CHANGES_TICK_MS * 2)));
const share = (patch: Partial<IncomingShare> = {}): IncomingShare => ({ title: "", text: "", url: "", files: [], ...patch });
/** The picker acts on a share once it has been seen: the clock moved past that. */
const settled = () => vi.setSystemTime(Date.now() + SEARCH_STATUS_SETTLE_MS);

/** What brings the picker up as a share comes in (the web app's service worker, Android's intake): the address. */
function ShareComesIn() {
  const go = useNavigate();
  return <button onClick={() => go("/shared")}>share comes in</button>;
}

async function openChat() {
  saveSession({ id: "heron", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", nick: "Heron", messages: [], createdAt: Date.now() - 600_000 });
  const utils = renderApp(<>
    <ShareComesIn />
    <Routes>
      <Route path="/chat/heron" element={<Chat sessionId="heron" visible onCallChange={() => {}} callLayer={null} />} />
      <Route path="/shared" element={<SharePicker />} />
    </Routes>
  </>, { route: "/chat/heron" });
  utils.engine.on("ensureLink", () => ({ linkId: LINK })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }))
    .on("editMessage", () => ({ error: null }))
    .update({ links: [linkView({ id: LINK, peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
  utils.engine.messages(LINK, [hello, mine]);
  await tick();
  await screen.findByText("heron note 8812");
  return utils;
}

const field = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message…");

/** ↑ in the empty field edits my last message; some words typed into the edit; then a share picked for this chat. */
async function editThenShare(user: Awaited<ReturnType<typeof openChat>>["user"]) {
  await user.click(field());
  await user.keyboard("{ArrowUp}");
  expect(screen.getByTestId("composer-edit")).toBeInTheDocument();
  expect(field()).toHaveValue("heron note 8812");
  fireEvent.change(field(), { target: { value: "heron note 8813" } });
  receiveShare(share({ text: "shared words" }));
  await user.click(screen.getByText("share comes in"));
  expect(screen.queryByTestId("composer-edit")).toBeNull();
  await screen.findByTestId("share-chat");
  settled();
  await user.click(screen.getByTestId("share-chat"));
  await tick();
}

beforeEach(() => resetIncomingShare());
afterEach(() => {
  resetIncomingShare();
  vi.useRealTimers();
});

describe("a chat left for the Share to… picker while one of my messages is edited there", () => {
  it("comes back with the edit open and its words; Enter saves only them, then the shared words are in the draft", async () => {
    const { engine, user } = await openChat();
    await editThenShare(user);
    expect(screen.getByTestId("composer-edit")).toHaveTextContent("heron note 8812");
    expect(field()).toHaveValue("heron note 8813");
    expect(peekShareFor("heron")?.text).toBe("shared words");

    await user.click(field());
    await user.keyboard("{Enter}");
    await tick();
    expect(engine.callsTo("editMessage").map((c) => c.text)).toEqual(["heron note 8813"]);
    expect(screen.queryByTestId("composer-edit")).toBeNull();
    expect(field()).toHaveValue("shared words");
    expect(peekShareFor("heron")).toBeNull();
    expect(engine.callsTo("sendMessage").filter((c) => /heron note|shared words/.test(c.text))).toEqual([]);
  });

  it("Escape leaves the edit: nothing is edited, and the shared words go in the draft", async () => {
    const { engine, user } = await openChat();
    await editThenShare(user);
    expect(field()).toHaveValue("heron note 8813");

    await user.click(field());
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("composer-edit")).toBeNull();
    expect(field()).toHaveValue("shared words");
    expect(engine.callsTo("editMessage")).toEqual([]);
  });

  it("a share picked for another chat leaves this edit as it is, and waits for that chat", async () => {
    const { user } = await openChat();
    await user.click(field());
    await user.keyboard("{ArrowUp}");
    fireEvent.change(field(), { target: { value: "heron note 8813" } });
    act(() => { receiveShare(share({ text: "for someone else" })); sendShareTo("other"); });
    await tick();
    expect(screen.getByTestId("composer-edit")).toBeInTheDocument();
    expect(field()).toHaveValue("heron note 8813");
    expect(peekShareFor("other")?.text).toBe("for someone else");
  });
});

describe("a group left for the Share to… picker while one of my messages is edited there", () => {
  const ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y");
  const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
  const MINE = `${ME}:1:0`;
  const box = () => screen.getByRole<HTMLTextAreaElement>("textbox");
  const lunch: StoredMessage = { linkId: "group:group-1", id: `${ALICE}:1:0`, text: "lunch at noon?", sender: "peer", member: ALICE, timestamp: 1_700_000_000_000, via: "datalink" };
  const ours: StoredMessage = { linkId: "group:group-1", id: MINE, text: "heron note 8812", sender: "me", timestamp: 1_700_000_001_000, via: "datalink" };

  it("comes back with the edit open and its words; Enter saves only them, then the shared words join the draft", async () => {
    fakeEngine.on("groupMessages", () => [lunch, ours]).on("updateSettings", () => undefined).on("sendGroupMessage", () => ({ error: null }))
      .on("editMessage", () => ({ error: null }));
    fakeEngine.update({ groups: [groupView({ status: "active", epoch: 1, members: [member({ key: ME, me: true }), member({ key: ALICE, nick: "Alice", role: "admin" })] })] });
    const { user, engine } = renderApp(<>
      <ShareComesIn />
      <Routes>
        <Route path="/group/:groupId" element={<GroupChat />} />
        <Route path="/shared" element={<SharePicker />} />
      </Routes>
    </>, { route: "/group/group-1" });
    await screen.findByText("heron note 8812");
    fireEvent.change(box(), { target: { value: "my draft" } });
    await user.click(document.querySelector<HTMLElement>(`[data-message-id="${MINE}"] [data-testid="message-options"]`)!);
    await user.click(screen.getByTestId("message-edit"));
    expect(box()).toHaveValue("heron note 8812");
    fireEvent.change(box(), { target: { value: "heron note 8813" } });

    receiveShare(share({ text: "shared words" }));
    await user.click(screen.getByText("share comes in"));
    await screen.findByTestId("share-group");
    settled();
    await user.click(screen.getByTestId("share-group"));
    expect(await screen.findByTestId("composer-edit")).toHaveTextContent("heron note 8812");
    await tick();
    expect(screen.getByTestId("composer-edit")).toHaveTextContent("heron note 8812");
    expect(box()).toHaveValue("heron note 8813");

    await user.click(box());
    await user.keyboard("{Enter}");
    await tick();
    expect(engine.callsTo("editMessage").map((c) => c.text)).toEqual(["heron note 8813"]);
    expect(screen.queryByTestId("composer-edit")).toBeNull();
    expect(box()).toHaveValue("my draft\nshared words");
    expect(engine.callsTo("sendGroupMessage")).toEqual([]);
  });
});

import { act, fireEvent, screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupMemberView, GroupView, MessageFile, StoredMessage } from "@ghostly/browser/shared/types";
import { NowPlayingBar } from "../../components/NowPlayingBar";
import { GroupChat } from "../../pages/GroupChat";
import { servicesPlatform } from "../../lib/platform";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";
import { audio, installFakeAudio } from "../voice/fakeMedia";

// covers: files.voice.now-playing

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

const ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y"), BOB = "bob".padEnd(52, "y");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
const group = (): GroupView => groupView({ name: "Ghost Club", status: "active", epoch: 1, canSend: true,
  members: [member({ key: ME, me: true }), member({ key: ALICE, nick: "Alice", role: "admin" }), member({ key: BOB, nick: "Bob" })] });
const VOICE: MessageFile = { id: "group-group-1-in-voice", name: "voice.webm", size: 40_000, mime: "audio/webm", voice: { duration: 42_000, peaks: Array(48).fill(90) } };
const history: StoredMessage[] = [
  { linkId: "group:group-1", id: `${BOB}:1:1`, text: "🎤 Voice message", sender: "peer", member: BOB, file: VOICE, timestamp: 1_700_000_003_000, via: "datalink" } as StoredMessage,
];

const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

function open() {
  fakeEngine.on("groupMessages", () => history).on("updateSettings", () => undefined).on("messagePage", () => ({ messages: history, more: false }))
    .on("forgetGroup", () => { fakeEngine.update({ groups: [] }); return undefined; })
    .on("leaveGroup", () => { fakeEngine.update({ groups: [] }); return {}; });
  fakeEngine.update({ groups: [group()], transfers: { [VOICE.id]: { state: "done", transferred: VOICE.size, size: VOICE.size, direction: "in" } as never } });
  return renderApp(
    <>
      <NowPlayingBar />
      <Routes>
        <Route path="/" element={<p data-testid="chat-list">Chat list</p>} />
        <Route path="/group/:groupId" element={<GroupChat />} />
      </Routes>
    </>,
    { route: "/group/group-1" },
  );
}

beforeEach(() => {
  installFakeAudio();
  vi.spyOn(servicesPlatform!, "getFile").mockImplementation(async (id: string) => new Blob([id], { type: "audio/webm" }));
});
afterEach(() => vi.restoreAllMocks());

describe("a group's voice message playing as the group goes from this device", () => {
  for (const how of ["forget", "leave"] as const) {
    it(`${how === "forget" ? "Delete from this device" : "Leave group"}: it stops, and no bar names the group`, async () => {
      const { user } = open();
      fireEvent.click(await screen.findByTestId("voice-play"));
      await flush();
      const player = audio.players[0]!;
      act(() => { player.currentTime = 3; player.dispatchEvent(new Event("timeupdate")); });
      expect(player.paused).toBe(false);

      await user.click(screen.getByTestId("group-options"));
      await user.click(screen.getByTestId(how === "forget" ? "group-forget" : "group-leave"));
      await user.click(within(screen.getByRole("dialog")).getByTestId("group-leave-confirm"));
      await flush();

      expect(screen.getByTestId("chat-list")).toBeInTheDocument();
      expect(player.paused).toBe(true);
      expect(screen.queryByTestId("now-playing")).toBeNull();
    });
  }
});

import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioBubble } from "../../components/audio/AudioBubble";
import { NowPlayingBar } from "../../components/NowPlayingBar";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { NowPlayingChat } from "../../lib/nowPlaying";
import { servicesPlatform } from "../../lib/platform";
import { listSessions, saveSession } from "../../lib/storage";
import type { ChatFile, ChatSession } from "../../lib/types";
import { chatPath } from "../../lib/url";
import { Settings } from "../../pages/Settings";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { windowIs } from "../viewport";
import { audio, installFakeAudio } from "../voice/fakeMedia";

// covers: chats.list.delete-all

const chat = (id: string, key: string): ChatSession =>
  ({ id, profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: key.repeat(52), encKeyB64: "a2V5", messages: [], createdAt: 1_700_000_000_000 });
const song: ChatFile = { id: "chat1-in-song", name: "Ghost Town.mp3", size: 4_000_000, mime: "audio/mpeg" };

/** Ana's chat with her audio file on screen, or (`open` false) Settings, Storage: the app's now-playing bar above either. */
function Screen({ open }: { open: boolean }) {
  return (
    <LockScreenProvider><UpdateProvider>
      <NowPlayingBar />
      {open ? (
        <NowPlayingChat.Provider value={{ path: chatPath("a"), name: "Ana", contact: true }}>
          <AudioBubble file={song} sender="peer" peerName="Ana" />
        </NowPlayingChat.Provider>
      ) : <Settings />}
    </UpdateProvider></LockScreenProvider>
  );
}

const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

beforeEach(() => {
  installFakeAudio();
  vi.spyOn(servicesPlatform!, "getFile").mockImplementation(async (id: string) => new Blob([id], { type: "audio/mpeg" }));
  fakeEngine.update({ links: [linkView({ id: "chat1" })], transfers: {} });
});

afterEach(() => vi.restoreAllMocks());

describe("Settings > Delete all chats while a chat's audio plays on", () => {
  // It played on from the deleted chat, under a bar that named it; its tap went to a chat that was gone.
  it("stops it, and its bar goes, as a chat deleted from the chat list does", async () => {
    windowIs(false);
    saveSession(chat("a", "a"));
    saveSession(chat("b", "b"));
    const view = renderApp(<Screen open />, { route: "/settings/storage" });
    fireEvent.click(await screen.findByTestId("audio-play"));
    await flush();
    const player = audio.players[0]!;
    expect(player.paused).toBe(false);

    // Settings: the bubble is gone, its audio plays on with the bar.
    view.rerender(<Screen open={false} />);
    expect(player.paused).toBe(false);
    expect(screen.getByTestId("now-playing")).toBeInTheDocument();

    const remove = await screen.findByTestId("delete-all-chats");
    await vi.waitFor(() => expect(remove).toBeEnabled());
    fireEvent.click(remove);
    fireEvent.click(screen.getByTestId("delete-all-chats-confirm"));
    expect(listSessions()).toHaveLength(0);
    expect(player.paused).toBe(true);
    expect(screen.queryByTestId("now-playing")).toBeNull();
  });
});

import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLocation } from "react-router-dom";
import { AudioBubble } from "../../components/audio/AudioBubble";
import { NowPlayingBar } from "../../components/NowPlayingBar";
import { VoiceBubble } from "../../components/voice/VoiceBubble";
import { JUMP_TO } from "../../hooks/useJumpTo";
import { userState } from "../../lib/navigation";
import { NowPlayingChat, pauseForCall, stopPlayingFrom, type PlayingChat } from "../../lib/nowPlaying";
import { servicesPlatform } from "../../lib/platform";
import type { ChatFile } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { audio, endPlayback, installFakeAudio } from "./fakeMedia";

// covers: files.voice.now-playing

const peaks = Array.from({ length: 32 }, (_, i) => (i * 37) % 256);
let n = 0;
const voiceFile = (): ChatFile & { voice: { duration: number; peaks: number[] } } =>
  ({ id: `chat1-in-np${++n}`, name: "Voice message.webm", size: 900, mime: "audio/webm", voice: { duration: 10_000, peaks } });
const song = (): ChatFile => ({ id: `chat1-in-npsong${++n}`, name: "Ghost Town.mp3", size: 4_000_000, mime: "audio/mpeg" });

/** Where the app went, and the message it was asked to land on. */
function Where() {
  const { pathname, state } = useLocation();
  return <p data-testid="where">{`${pathname} ${String(userState(state)?.[JUMP_TO] ?? "")}`}</p>;
}

const FAMILY: PlayingChat = { path: "/group/family", name: "Family" };

/** A chat named Family with these messages, or (`open` false) another page: the app's bar above either. */
function Screen({ files, open = true, audioFiles = [], where = FAMILY }: { files: ChatFile[]; open?: boolean; audioFiles?: ChatFile[]; where?: PlayingChat }) {
  return (
    <>
      <NowPlayingBar />
      {open && (
        <NowPlayingChat.Provider value={where}>
          {files.map((file) => (
            <div key={file.id} data-message-id={`m-${file.id}`}>
              <VoiceBubble file={file as ChatFile & { voice: { duration: number; peaks: number[] } }} sender="peer" peerName="Ana" />
            </div>
          ))}
          {audioFiles.map((file) => (
            <div key={file.id} data-message-id={`m-${file.id}`}>
              <AudioBubble file={file} sender="peer" peerName="Ana" />
            </div>
          ))}
        </NowPlayingChat.Provider>
      )}
      <Where />
    </>
  );
}

const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
const bar = () => screen.queryByTestId("now-playing");
/** The element moves on, as a playing one does. */
function playTo(player: HTMLAudioElement, at: number) {
  act(() => {
    player.currentTime = at;
    player.dispatchEvent(new Event("timeupdate"));
  });
}

beforeEach(() => {
  installFakeAudio();
  vi.spyOn(servicesPlatform!, "getFile").mockImplementation(async (id: string) => new Blob([id], { type: id.includes("song") ? "audio/mpeg" : "audio/webm" }));
  fakeEngine.update({ links: [linkView({ id: "chat1" })], transfers: {} });
});

afterEach(() => vi.restoreAllMocks());

describe("a voice message playing as its chat goes", () => {
  it("plays on, with a bar that names who sent it and where; back in the chat its bubble has it where it is", async () => {
    const file = voiceFile();
    const view = renderApp(<Screen files={[file]} />, { route: "/group/family" });
    expect(bar()).toBeNull();
    fireEvent.click(screen.getByTestId("voice-play"));
    await flush();
    const player = audio.players[0]!;
    playTo(player, 3);

    // Another page: the bubble is gone, the recording is not.
    view.rerender(<Screen files={[file]} open={false} />);
    expect(screen.queryByTestId("voice-bubble")).toBeNull();
    expect(player.paused).toBe(false);
    expect(player.getAttribute("src")).toMatch(/^blob:/);
    const region = screen.getByRole("region", { name: "Now playing" });
    expect(region).toHaveAttribute("data-state", "playing");
    expect(within(region).getByTestId("now-playing-from")).toHaveTextContent("Ana · Family");
    expect(within(region).getByTestId("now-playing-title")).toHaveTextContent("Voice message");
    playTo(player, 4);
    expect(within(region).getByTestId("now-playing-time")).toHaveTextContent("0:04 / 0:10");

    // Back: the same player, still playing, and the bar goes.
    view.rerender(<Screen files={[file]} />);
    expect(bar()).toBeNull();
    expect(audio.players).toHaveLength(1);
    expect(screen.getByTestId("voice-bubble")).toHaveAttribute("data-state", "playing");
    expect(screen.getByTestId("voice-time")).toHaveTextContent("0:04");
    // And this bubble drives it again: its pause pauses that same element.
    fireEvent.click(screen.getByRole("button", { name: "Pause voice message" }));
    expect(player.paused).toBe(true);
    expect(screen.getByTestId("voice-bubble")).toHaveAttribute("data-state", "paused");
  });

  it("from a chat with one contact, the bar names them once, as their chat does", async () => {
    const file = voiceFile();
    const ana: PlayingChat = { path: "/chat/ana", name: "Ana Lima", contact: true };
    const view = renderApp(<Screen files={[file]} where={ana} />);
    fireEvent.click(screen.getByTestId("voice-play"));
    await flush();
    view.rerender(<Screen files={[file]} where={ana} open={false} />);
    expect(screen.getByTestId("now-playing-from")).toHaveTextContent(/^Ana Lima$/);
  });

  it("the bar pauses and plays it, from the keyboard too, and says where it is in the app's language", async () => {
    const file = voiceFile();
    const view = renderApp(<Screen files={[file]} />, { route: "/group/family", language: "pt" });
    fireEvent.click(screen.getByTestId("voice-play"));
    await flush();
    const player = audio.players[0]!;
    playTo(player, 3);
    view.rerender(<Screen files={[file]} open={false} />);

    const region = screen.getByRole("region", { name: "Tocando agora" });
    expect(within(region).getByTestId("now-playing-time")).toHaveTextContent("0:03 de 0:10");
    const pause = within(region).getByRole("button", { name: "Pausar mensagem de voz" });
    pause.focus();
    await view.user.keyboard("{Enter}");
    expect(player.paused).toBe(true);
    expect(region).toHaveAttribute("data-state", "paused");
    // Paused, the bar stays: its play goes on from there.
    await view.user.click(within(region).getByRole("button", { name: "Tocar mensagem de voz" }));
    expect(player.paused).toBe(false);
    expect(player.currentTime).toBe(3);
  });

  it("close stops it, and it starts again where it stopped; a tap on the bar opens its chat at the message", async () => {
    const file = voiceFile();
    const view = renderApp(<Screen files={[file]} />, { route: "/group/family" });
    fireEvent.click(screen.getByTestId("voice-play"));
    await flush();
    const player = audio.players[0]!;
    playTo(player, 6);
    view.rerender(<Screen files={[file]} open={false} />);

    await view.user.click(screen.getByTestId("now-playing-open"));
    expect(screen.getByTestId("where")).toHaveTextContent(`/group/family m-${file.id}`);

    view.rerender(<Screen files={[file]} open={false} />);
    await view.user.click(screen.getByRole("button", { name: "Stop and close" }));
    expect(bar()).toBeNull();
    expect(player.paused).toBe(true);
    // Its bytes are let go of; the place where it stopped is kept.
    expect(player.hasAttribute("src")).toBe(false);
    view.rerender(<Screen files={[file]} />);
    expect(screen.getByTestId("voice-time")).toHaveTextContent("0:06");
    fireEvent.click(screen.getByTestId("voice-play"));
    await flush();
    expect(audio.players).toHaveLength(2);
    expect(audio.players[1]!.currentTime).toBe(6);
  });

  it("played to its end away from its chat: the bar goes, and it starts from the beginning next time", async () => {
    const file = voiceFile();
    const view = renderApp(<Screen files={[file]} />);
    fireEvent.click(screen.getByTestId("voice-play"));
    await flush();
    const player = audio.players[0]!;
    playTo(player, 8);
    view.rerender(<Screen files={[file]} open={false} />);
    act(() => endPlayback(player));
    expect(bar()).toBeNull();
    expect(player.hasAttribute("src")).toBe(false);
    view.rerender(<Screen files={[file]} />);
    expect(screen.getByTestId("voice-time")).toHaveTextContent("0:10");
    expect(screen.getByTestId("voice-bubble")).toHaveAttribute("data-state", "idle");
  });

  it("starting another stops the one playing on, and the bar goes", async () => {
    const [first, second] = [voiceFile(), voiceFile()];
    const view = renderApp(<Screen files={[first]} />);
    fireEvent.click(screen.getByTestId("voice-play"));
    await flush();
    const held = audio.players[0]!;
    playTo(held, 2);
    view.rerender(<Screen files={[first]} open={false} />);
    expect(bar()).not.toBeNull();

    // Another chat, another voice message.
    view.rerender(<Screen files={[second]} />);
    fireEvent.click(screen.getByTestId("voice-play"));
    await flush();
    expect(held.paused).toBe(true);
    expect(bar()).toBeNull();
    expect(audio.players[1]!.paused).toBe(false);
    // The first one starts again where it was stopped.
    view.rerender(<Screen files={[first]} />);
    expect(screen.getByTestId("voice-time")).toHaveTextContent("0:02");
  });

  it("a call starting pauses it, held by the app or in its bubble", async () => {
    const file = voiceFile();
    const view = renderApp(<Screen files={[file]} />);
    fireEvent.click(screen.getByTestId("voice-play"));
    await flush();
    const player = audio.players[0]!;
    act(() => pauseForCall());
    expect(player.paused).toBe(true);
    expect(screen.getByTestId("voice-bubble")).toHaveAttribute("data-state", "paused");

    fireEvent.click(screen.getByTestId("voice-play"));
    await flush();
    view.rerender(<Screen files={[file]} open={false} />);
    expect(bar()).toHaveAttribute("data-state", "playing");
    act(() => pauseForCall());
    expect(player.paused).toBe(true);
    // Paused, not stopped: the bar stays, to play it on after the call.
    expect(bar()).toHaveAttribute("data-state", "paused");
  });

  it("paused part-way, then left: it starts again where it stopped, for this session", async () => {
    const file = voiceFile();
    const view = renderApp(<Screen files={[file]} />);
    fireEvent.click(screen.getByTestId("voice-play"));
    await flush();
    playTo(audio.players[0]!, 5);
    fireEvent.click(screen.getByRole("button", { name: "Pause voice message" }));
    view.rerender(<Screen files={[file]} open={false} />);
    // Paused, it does not play on: no bar.
    expect(bar()).toBeNull();
    view.rerender(<Screen files={[file]} />);
    expect(screen.getByTestId("voice-time")).toHaveTextContent("0:05");
    expect(screen.getByTestId("voice-waveform")).toHaveAttribute("aria-valuenow", "5");
    fireEvent.click(screen.getByTestId("voice-play"));
    await flush();
    expect(audio.players[audio.players.length - 1]!.currentTime).toBe(5);
  });
});

describe("an audio file playing as its chat goes", () => {
  it("plays on out of the chat with the bar, and back in its chat goes on from where it is", async () => {
    const file = song();
    const view = renderApp(<Screen files={[]} audioFiles={[file]} />);
    fireEvent.click(screen.getByTestId("audio-play"));
    await flush();
    const player = screen.getByTestId("audio-element") as HTMLAudioElement;
    Object.defineProperty(player, "duration", { configurable: true, value: 225 });
    fireEvent.loadedMetadata(player);
    playTo(player, 90);

    view.rerender(<Screen files={[]} audioFiles={[file]} open={false} />);
    expect(screen.queryByTestId("audio-bubble")).toBeNull();
    // Still in the page, so still playing.
    expect(player.isConnected).toBe(true);
    expect(player.paused).toBe(false);
    expect(within(bar()!).getByTestId("now-playing-title")).toHaveTextContent("Ghost Town.mp3");
    expect(within(bar()!).getByTestId("now-playing-time")).toHaveTextContent("1:30 / 3:45");

    view.rerender(<Screen files={[]} audioFiles={[file]} />);
    await flush();
    expect(bar()).toBeNull();
    expect(player.isConnected).toBe(false);
    const again = screen.getByTestId("audio-element") as HTMLAudioElement;
    expect(again.currentTime).toBe(90);
    expect(again.paused).toBe(false);
    expect(screen.getByTestId("audio-bubble")).toHaveAttribute("data-state", "playing");
  });
});

describe("a voice message playing on as its chat goes from this device", () => {
  it("stops, and the bar goes, when that chat is deleted; another chat going leaves it playing", async () => {
    const file = voiceFile();
    const view = renderApp(<Screen files={[file]} />, { route: "/group/family" });
    fireEvent.click(screen.getByTestId("voice-play"));
    await flush();
    const player = audio.players[0]!;
    playTo(player, 3);
    view.rerender(<Screen files={[file]} open={false} />);
    expect(bar()).not.toBeNull();

    act(() => stopPlayingFrom("/group/other", false));
    expect(player.paused).toBe(false);
    expect(bar()).not.toBeNull();

    act(() => stopPlayingFrom(FAMILY.path, false));
    expect(player.paused).toBe(true);
    expect(bar()).toBeNull();
  });
});

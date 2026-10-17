import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioBubble } from "../../components/audio/AudioBubble";
import { VoiceBubble } from "../../components/voice/VoiceBubble";
import { LockScreenProvider, useLockScreen } from "../../contexts/LockScreenContext";
import { handOverUnlock } from "../../lib/lockHandover";
import { servicesPlatform } from "../../lib/platform";
import { activeProfileId } from "../../lib/profiles";
import type { ChatFile } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { audio, installFakeAudio } from "./fakeMedia";

// covers: files.voice.media-session

/*
 * The system's media controls show what plays outside the app: the lock screen, the notification shade, Now Playing,
 * the panel. They say what a notice says (what it is, from Ghostly), never who sent it or a file's name; and when the
 * app locks, nothing of a chat plays on behind the lock or stays on them.
 */

type Handler = (details: { seekTime?: number }) => void;
const handlers = new Map<string, Handler | null>();
const session = {
  metadata: null as unknown,
  playbackState: "none",
  setActionHandler: (action: string, handler: Handler | null) => { handlers.set(action, handler); },
  setPositionState: vi.fn(),
};

const peaks = Array.from({ length: 32 }, (_, i) => (i * 37) % 256);
let n = 0;
const voiceFile = () => ({ id: `chat1-in-msp${++n}`, name: "Voice message.webm", size: 900, mime: "audio/webm", voice: { duration: 10_000, peaks } });
const song = (): ChatFile => ({ id: `chat1-in-mspsong${++n}`, name: "Ghost Town.mp3", size: 4_000_000, mime: "audio/mpeg" });

function LockButton() {
  const { isLocked, lock } = useLockScreen();
  return <button data-testid="lock" onClick={lock}>{String(isLocked)}</button>;
}

function Screen({ voice = [], songs = [] }: { voice?: ReturnType<typeof voiceFile>[]; songs?: ChatFile[] }) {
  return (
    <LockScreenProvider>
      <LockButton />
      {voice.map((file) => <VoiceBubble key={file.id} file={file} sender="peer" peerName="Ana Souza" />)}
      {songs.map((file) => <AudioBubble key={file.id} file={file} sender="peer" peerName="Ana Souza" />)}
    </LockScreenProvider>
  );
}

const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
const shown = () => JSON.stringify((session.metadata as { init?: object } | null)?.init ?? null);

beforeEach(() => {
  installFakeAudio();
  handlers.clear();
  session.metadata = null;
  session.playbackState = "none";
  Object.defineProperty(navigator, "mediaSession", { configurable: true, value: session });
  vi.stubGlobal("MediaMetadata", class { constructor(public init: object) {} });
  vi.spyOn(servicesPlatform!, "getFile").mockImplementation(async (id: string) => new Blob([id], { type: id.includes("song") ? "audio/mpeg" : "audio/webm" }));
  fakeEngine.update({ links: [linkView({ id: "chat1" })], transfers: {} });
  localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: "x", timeoutMinutes: 5 } }));
  handOverUnlock(activeProfileId(), "x");
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "mediaSession");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe("what the system's media controls show", () => {
  it("a voice message: \"Voice message\" from Ghostly, never the contact", async () => {
    renderApp(<Screen voice={[voiceFile()]} />);
    fireEvent.click(screen.getByTestId("voice-play"));
    await flush();
    expect(session.metadata).toMatchObject({ init: { title: "Voice message", artist: "Ghostly" } });
    expect(shown()).not.toContain("Ana");
  });

  it("an audio file: \"Audio\" from Ghostly, never its name or who sent it, in the app's language too", async () => {
    renderApp(<Screen songs={[song()]} />, { language: "pt" });
    fireEvent.click(screen.getByTestId("audio-play"));
    await flush();
    expect(session.metadata).toMatchObject({ init: { title: "Áudio", artist: "Ghostly" } });
    expect(shown()).not.toMatch(/Ghost Town|Ana/);
  });
});

describe("the app locking while something plays", () => {
  it("pauses a voice message in its bubble and the system's controls let go of it", async () => {
    renderApp(<Screen voice={[voiceFile()]} />);
    fireEvent.click(screen.getByTestId("voice-play"));
    await flush();
    const player = audio.players[0]!;
    expect(player.paused).toBe(false);
    act(() => { fireEvent.click(screen.getByTestId("lock")); });
    expect(screen.getByTestId("lock").textContent).toBe("true");
    expect(player.paused).toBe(true);
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe("none");
    expect(handlers.get("play")).toBeNull();
  });

  it("pauses an audio file in its bubble and the system's controls let go of it", async () => {
    renderApp(<Screen songs={[song()]} />);
    fireEvent.click(screen.getByTestId("audio-play"));
    await flush();
    const player = screen.getByTestId("audio-element") as HTMLAudioElement;
    expect(player.paused).toBe(false);
    act(() => { fireEvent.click(screen.getByTestId("lock")); });
    expect(player.paused).toBe(true);
    expect(session.metadata).toBeNull();
    expect(handlers.get("play")).toBeNull();
  });
});

import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import type { StoredMessage } from "@ghostly/browser/shared/types";
import { App } from "../../App";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { holdPlayback, resetNowPlaying } from "../../lib/nowPlaying";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: files.voice.now-playing, chat.paired.delete-message

/**
 * A voice message playing on from another page (the bar) while its sender deletes it for everyone: the engine names the
 * rows that went, of a chat or a group, and the app stops what plays from one of them, whatever page is open. It played
 * on to its end, the message gone from the chat (WISP 400 § Delete for everyone: a reader keeps no file of it).
 */
const row = (id: string): StoredMessage => ({ linkId: "link-1", id, text: "", sender: "peer", timestamp: 1_700_000_000_000, via: "datalink" });

function playAway(messageId: string) {
  const audio = document.createElement("audio");
  let paused = false;
  Object.defineProperty(audio, "paused", { get: () => paused });
  audio.pause = () => { paused = true; audio.dispatchEvent(new Event("pause")); };
  const release = vi.fn();
  act(() => holdPlayback({ id: `link-1-in-${messageId}`, kind: "voice", title: "Voice message", label: "Voice message", from: "Ana", messageId, duration: 10, audio, release }));
  return { audio, release };
}

function renderPages() {
  return renderApp(
    <LockScreenProvider><UpdateProvider>
      <Routes><Route element={<App />}><Route path="/" element={<p>Home</p>} /></Route></Routes>
    </UpdateProvider></LockScreenProvider>,
    { route: "/" },
  );
}

afterEach(() => resetNowPlaying());

describe("a voice message playing on as its message is deleted", () => {
  it("stops when the engine's change names its message; another message going leaves it playing", async () => {
    renderPages();
    act(() => fakeEngine.messages("link-1", [row("peer_keep"), row("peer_gone"), row("peer_other")]));
    const { audio, release } = playAway("peer_gone");
    expect(await screen.findByTestId("now-playing")).toBeInTheDocument();

    act(() => fakeEngine.messages("link-1", [row("peer_keep"), row("peer_gone")], ["peer_other"]));
    expect(audio.paused).toBe(false);
    expect(screen.getByTestId("now-playing")).toBeInTheDocument();

    act(() => fakeEngine.messages("link-1", [row("peer_keep")], ["peer_other", "peer_gone"]));
    expect(audio.paused).toBe(true);
    expect(release).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("now-playing")).toBeNull();
  });
});

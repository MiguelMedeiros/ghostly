import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import { TransportLine } from "../../components/TransportTimeline";
import type { MessageAuthor } from "../../components/chat/SenderAvatar";
import { servicesPlatform } from "../../lib/platform";
import type { ChatMessage } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { lookup } from "../i18n/locales";
import { audio, endPlayback, installFakeAudio } from "./fakeMedia";

// covers: files.voice.play, files.voice.autoplay, files.large.resend, files.large.request

const peaks = Array.from({ length: 64 }, (_, i) => (i * 37) % 256);
let n = 0;

function voice(patch: Partial<ChatMessage> = {}, duration = 7_400): ChatMessage {
  const id = `link-1-in-voice${++n}`;
  return {
    id: `peer_${n}`, text: "🎤 Voice message (0:07)", sender: "peer", timestamp: 1_700_000_000_000 + n,
    file: { id, name: "Voice message.webm", size: 1234, mime: "audio/webm", voice: { duration, peaks } },
    ...patch,
  };
}

function chat(...messages: ChatMessage[]) {
  return renderApp(<div>{messages.map((m) => <MessageBubble key={m.id} message={m} peerPubKey="peer" />)}</div>);
}

const bubbles = () => screen.getAllByTestId("voice-bubble");
const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

beforeEach(() => {
  installFakeAudio();
  vi.spyOn(servicesPlatform!, "getFile").mockImplementation(async () => new Blob(["opus"], { type: "audio/webm" }));
});

afterEach(() => vi.restoreAllMocks());

describe("a voice message in the chat", () => {
  it("shows its length and its waveform, and reads no bytes until it plays", () => {
    chat(voice());
    const bubble = screen.getByTestId("voice-bubble");
    expect(within(bubble).getByTestId("voice-time")).toHaveTextContent("0:07");
    expect(bubble.querySelectorAll(".voice-wave-base .voice-wave-bar")).toHaveLength(64);
    expect(within(bubble).getByRole("slider", { name: "Position in voice message" })).toHaveAttribute("aria-valuemax", "7");
    expect(servicesPlatform!.getFile).not.toHaveBeenCalled();
  });

  it("is a voice message only with its description: a plain audio file gets the audio file player", () => {
    const plain = voice();
    delete plain.file!.voice;
    chat(plain);
    expect(screen.queryByTestId("voice-bubble")).not.toBeInTheDocument();
    expect(screen.getByTestId("audio-bubble")).toBeInTheDocument();
  });

  it("plays and pauses", async () => {
    chat(voice());
    fireEvent.click(screen.getByRole("button", { name: "Play voice message" }));
    await flush();
    expect(audio.players).toHaveLength(1);
    expect(screen.getByTestId("voice-bubble")).toHaveAttribute("data-state", "playing");
    expect(audio.players[0]!.src).toMatch(/^blob:/);

    fireEvent.click(screen.getByRole("button", { name: "Pause voice message" }));
    expect(screen.getByTestId("voice-bubble")).toHaveAttribute("data-state", "paused");
    expect(audio.players[0]!.paused).toBe(true);
  });

  it("marks a received one unplayed until it is played, and remembers it", async () => {
    const message = voice();
    const { unmount } = chat(message);
    expect(screen.getByTestId("voice-unplayed")).toBeInTheDocument();
    expect(screen.getByTestId("voice-bubble")).toHaveAttribute("data-played", "false");
    fireEvent.click(screen.getByRole("button", { name: "Play voice message" }));
    await flush();
    expect(screen.queryByTestId("voice-unplayed")).not.toBeInTheDocument();
    unmount();

    chat(message);
    expect(screen.getByTestId("voice-bubble")).toHaveAttribute("data-played", "true");
  });

  it("never marks one's own voice messages unplayed", () => {
    chat(voice({ sender: "me", id: "me_1" }));
    expect(screen.queryByTestId("voice-unplayed")).not.toBeInTheDocument();
  });

  it("plays one at a time", async () => {
    chat(voice(), voice({ text: "between" }));
    const [first, second] = bubbles();
    fireEvent.click(within(first!).getByTestId("voice-play"));
    await flush();
    fireEvent.click(within(second!).getByTestId("voice-play"));
    await flush();
    expect(first).toHaveAttribute("data-state", "paused");
    expect(second).toHaveAttribute("data-state", "playing");
    expect(audio.players[0]!.paused).toBe(true);
  });

  /** The bytes arrive when the test says: each read waits for `arrive()`, oldest first. */
  function slowFiles() {
    const waiting: Array<() => void> = [];
    vi.mocked(servicesPlatform!.getFile).mockImplementation(() => new Promise((resolve) => {
      waiting.push(() => resolve(new Blob(["opus"], { type: "audio/webm" })));
    }));
    return { arrive: async (index = 0) => { waiting.splice(index, 1)[0]!(); await flush(); await flush(); } };
  }
  const unpaused = () => audio.players.filter((player) => !player.paused);

  it("does not start once its bubble is gone, when the bytes arrive after the chat was left", async () => {
    const files = slowFiles();
    const { unmount } = chat(voice());
    fireEvent.click(screen.getByTestId("voice-play"));
    await flush();
    unmount();
    await files.arrive();
    expect(unpaused()).toHaveLength(0);
  });

  it("does not start behind another one tapped while it was still loading", async () => {
    const files = slowFiles();
    chat(voice(), voice({ text: "between" }));
    const [first, second] = bubbles();
    fireEvent.click(within(first!).getByTestId("voice-play"));
    await flush();
    fireEvent.click(within(second!).getByTestId("voice-play"));
    await flush();
    // The second one's bytes come first, then the first one's, late.
    await files.arrive(1);
    await files.arrive(0);
    expect(unpaused()).toHaveLength(1);
    expect(second).toHaveAttribute("data-state", "playing");
    expect(first).toHaveAttribute("data-state", "idle");
    // Its play button works again.
    expect(within(first!).getByTestId("voice-play")).toBeEnabled();
  });

  it("goes on to the next voice message from the same sender, and stops at anything else", async () => {
    chat(voice(), voice(), voice({ sender: "me", id: "me_x" }), voice());
    const [first, second, mine] = bubbles();
    fireEvent.click(within(first!).getByTestId("voice-play"));
    await flush();
    endPlayback(audio.players[0]!);
    await flush();
    expect(first).toHaveAttribute("data-state", "idle");
    expect(second).toHaveAttribute("data-state", "playing");

    // The next one is this device's own: the run ends.
    endPlayback(audio.players[1]!);
    await flush();
    expect(mine).toHaveAttribute("data-state", "idle");
    expect(audio.players).toHaveLength(2);
  });

  it("does not go on past a text message", async () => {
    chat(voice(), { id: "t1", text: "hello", sender: "peer", timestamp: 1 }, voice());
    const [first, last] = bubbles();
    fireEvent.click(within(first!).getByTestId("voice-play"));
    await flush();
    endPlayback(audio.players[0]!);
    await flush();
    expect(last).toHaveAttribute("data-state", "idle");
  });

  it("in a group, goes on to the same member's next voice message, never to another member's", async () => {
    const by = (key: string): MessageAuthor => ({ key, name: key, first: true, last: true });
    const [ana, ana2, bob] = [voice(), voice(), voice()];
    renderApp(<div>
      <MessageBubble message={ana} author={by("ana")} />
      <MessageBubble message={ana2} author={by("ana")} />
      <MessageBubble message={bob} author={by("bob")} />
    </div>);
    const [first, second, third] = bubbles();
    fireEvent.click(within(first!).getByTestId("voice-play"));
    await flush();
    endPlayback(audio.players[0]!);
    await flush();
    expect(second).toHaveAttribute("data-state", "playing");

    endPlayback(audio.players[1]!);
    await flush();
    expect(third).toHaveAttribute("data-state", "idle");
    expect(audio.players).toHaveLength(2);
  });

  it.each([
    ["a group event", <div key="e" data-testid="group-event"><span>Ana joined</span></div>],
    ["a group payment", <div key="p" data-testid="group-payment"><MessageBubble message={{ id: "t9", text: "paid", sender: "peer", timestamp: 1 }} /></div>],
  ])("does not go on past %s", async (_, between) => {
    renderApp(<div>
      <MessageBubble message={voice()} />
      {between}
      <MessageBubble message={voice()} />
    </div>);
    const [first, last] = bubbles();
    fireEvent.click(within(first!).getByTestId("voice-play"));
    await flush();
    endPlayback(audio.players[0]!);
    await flush();
    expect(last).toHaveAttribute("data-state", "idle");
  });

  it("goes on past a line about the connection: it is not part of the conversation", async () => {
    renderApp(<div>
      <MessageBubble message={voice()} peerPubKey="peer" />
      <TransportLine entry={{ id: "l1", at: 1, kind: "switched", transport: "iroh/1", from: "webrtc/1" }} contact="Ana" />
      <MessageBubble message={voice()} peerPubKey="peer" />
    </div>);
    const [first, last] = bubbles();
    fireEvent.click(within(first!).getByTestId("voice-play"));
    await flush();
    endPlayback(audio.players[0]!);
    await flush();
    expect(last).toHaveAttribute("data-state", "playing");
  });

  it("changes speed for every voice message at once: 1×, 1.5×, 2×, and back", async () => {
    chat(voice(), voice());
    const [first, second] = bubbles();
    fireEvent.click(within(first!).getByTestId("voice-play"));
    await flush();
    const speed = within(first!).getByTestId("voice-speed");
    expect(speed).toHaveTextContent("1×");
    fireEvent.click(speed);
    expect(speed).toHaveTextContent("1.5×");
    expect(audio.players[0]!.playbackRate).toBe(1.5);
    fireEvent.click(speed);
    expect(speed).toHaveTextContent("2×");
    expect(audio.players[0]!.playbackRate).toBe(2);

    fireEvent.click(within(second!).getByTestId("voice-play"));
    await flush();
    expect(audio.players[1]!.playbackRate).toBe(2);
    fireEvent.click(within(second!).getByTestId("voice-speed"));
    expect(within(second!).getByTestId("voice-speed")).toHaveTextContent("1×");
  });

  it("plays faster with the voice at its own pitch, and remembers the speed for the next one on this device", async () => {
    const first = chat(voice());
    fireEvent.click(screen.getByTestId("voice-play"));
    await flush();
    const player = audio.players[0]! as HTMLAudioElement & { webkitPreservesPitch?: boolean };
    expect(player.playbackRate).toBe(1);
    expect(player.preservesPitch).toBe(true);
    expect(player.webkitPreservesPitch).toBe(true);
    fireEvent.click(screen.getByTestId("voice-speed"));
    expect(player.playbackRate).toBe(1.5);
    // A new source (the decoded WAV) resets the rate to the default one: that follows too.
    expect(player.defaultPlaybackRate).toBe(1.5);
    expect(player.preservesPitch).toBe(true);
    expect(localStorage.getItem("ghostly-voice-rate")).toBe("1.5");
    first.unmount();

    // Another voice message, later: it starts at the speed last chosen.
    chat(voice());
    fireEvent.click(screen.getByTestId("voice-play"));
    await flush();
    expect(audio.players[1]!.playbackRate).toBe(1.5);
    expect(screen.getByTestId("voice-speed")).toHaveTextContent("1.5×");
  });

  it.each([
    ["en", "1.5×"],
    ["pt", "1,5×"],
    ["fr", "1,5×"],
    ["ja", "1.5×"],
    // Latin digits, as the clock beside it has in every language.
    ["ar", "1.5×"],
  ] as const)("shows the speed in the app language's decimals (%s: %s)", async (language, label) => {
    localStorage.setItem("ghostly-voice-rate", "1.5");
    renderApp(<MessageBubble message={voice()} peerPubKey="peer" />, { language });
    fireEvent.click(screen.getByTestId("voice-play"));
    await flush();
    const speed = screen.getByTestId("voice-speed");
    expect(speed).toHaveTextContent(label);
    // Named in the app language too, around the same number.
    expect(speed).toHaveAccessibleName(lookup(language, "chat.voice.speed")!.replace("{{speed}}", label));
  });

  it("takes the mic's place while it plays, is a button the keyboard can use, and hands focus back to play when it goes", async () => {
    chat(voice());
    const bubble = screen.getByTestId("voice-bubble");
    expect(within(bubble).queryByTestId("voice-speed")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("voice-play"));
    await flush();
    const meta = screen.getByTestId("voice-meta");
    // In the mic's place, first on the line, before the time.
    expect(meta.firstElementChild).toBe(screen.getByTestId("voice-speed"));
    expect(within(meta).queryByTestId("voice-unplayed")).not.toBeInTheDocument();
    // Tapping it leaves playback alone.
    const speed = screen.getByRole("button", { name: "Playback speed 1×" });
    speed.focus();
    fireEvent.click(speed);
    expect(bubble).toHaveAttribute("data-state", "playing");
    expect(audio.players[0]!.paused).toBe(false);
    expect(document.activeElement).toBe(speed);

    // The recording ends with the keyboard on the pill: it goes to play, not to the page.
    endPlayback(audio.players[0]!);
    await flush();
    expect(screen.queryByTestId("voice-speed")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByTestId("voice-play"));
    expect(within(meta).getByTestId("voice-mic")).toBeInTheDocument();
  });

  it("moves to where the waveform is tapped or dragged", async () => {
    chat(voice({}, 10_000));
    const wave = screen.getByTestId("voice-waveform");
    vi.spyOn(wave, "getBoundingClientRect").mockReturnValue({ left: 100, width: 200, top: 0, height: 28, right: 300, bottom: 28, x: 100, y: 0, toJSON() {} });
    fireEvent.pointerDown(wave, { button: 0, pointerId: 1, clientX: 200 });
    expect(wave).toHaveAttribute("aria-valuenow", "5");
    expect(screen.getByTestId("voice-time")).toHaveTextContent("0:05");
    expect(wave.style.getPropertyValue("--voice-progress")).toBe("0.5");
    fireEvent.pointerMove(wave, { pointerId: 1, clientX: 250 });
    fireEvent.pointerUp(wave, { pointerId: 1, clientX: 250 });
    expect(wave).toHaveAttribute("aria-valuenow", "8");

    // It plays from there.
    fireEvent.click(screen.getByTestId("voice-play"));
    await flush();
    expect(audio.players[0]!.currentTime).toBeCloseTo(7.5);
  });

  it("moves with the keyboard", () => {
    chat(voice({}, 20_000));
    const wave = screen.getByTestId("voice-waveform");
    fireEvent.keyDown(wave, { key: "End" });
    expect(wave).toHaveAttribute("aria-valuenow", "20");
    fireEvent.keyDown(wave, { key: "ArrowLeft" });
    expect(wave).toHaveAttribute("aria-valuenow", "19");
    fireEvent.keyDown(wave, { key: "Home" });
    expect(wave).toHaveAttribute("aria-valuenow", "0");
  });

  it("offers the file when this device cannot play its type", async () => {
    audio.canPlay = (type) => (type === "audio/mp4" ? "" : "maybe");
    const aac = voice();
    aac.file = { ...aac.file!, mime: "audio/mp4", name: "Voice message.m4a" };
    chat(aac);
    fireEvent.click(screen.getByTestId("voice-play"));
    await flush();
    expect(screen.getByTestId("voice-problem")).toHaveTextContent("This device can't play M4A recordings");
    expect(screen.getByTestId("voice-save")).toHaveAttribute("download", "Voice message.m4a");
    expect(audio.players).toHaveLength(0);
  });

  it("says so when the bytes are gone", async () => {
    vi.mocked(servicesPlatform!.getFile).mockResolvedValue(null);
    chat(voice());
    fireEvent.click(screen.getByTestId("voice-play"));
    await flush();
    expect(screen.getByTestId("voice-problem")).toHaveTextContent("No longer available");
  });

  it("cannot be played while it is still arriving, and shows how far it got", () => {
    const message = voice();
    fakeEngine.update({ transfers: { [message.file!.id]: { state: "transferring", transferred: 617, size: 1234 } } });
    chat(message);
    expect(screen.getByTestId("voice-play")).toBeDisabled();
    expect(screen.getByTestId("voice-status")).toHaveTextContent("50% of");
    // A ring around the play button fills as it moves.
    expect(screen.getByTestId("voice-progress").querySelectorAll("circle")[1]).toHaveAttribute("stroke-dashoffset", expect.stringMatching(/^5\d\./));
  });

  it("not sent, its play button becomes a red ↻ that sends it again, with the reason behind the ⓘ", async () => {
    const retryFile = vi.spyOn(servicesPlatform!, "retryFile").mockResolvedValue();
    const mine = voice({ id: "me_1", sender: "me" });
    mine.file!.id = "link-1-out-voice-failed";
    fakeEngine.update({ links: [linkView({ id: "link-1" })], transfers: {
      [mine.file!.id]: { state: "failed", direction: "out", transferred: 0, size: 1234, error: "Connection lost", retry: true },
    } });
    chat(mine);
    expect(screen.queryByTestId("voice-play")).toBeNull();
    expect(screen.getByTestId("voice-status")).toHaveTextContent("· Not sent");
    expect(screen.queryByText("Connection lost")).toBeNull();
    fireEvent.click(screen.getByTestId("voice-why"));
    expect(screen.getByTestId("voice-why-text")).toHaveTextContent("Connection lost");
    const button = screen.getByRole("button", { name: "Send again" });
    expect(button).toHaveAttribute("data-testid", "voice-retry");
    expect(button).toHaveAttribute("data-tone", "danger");
    fireEvent.click(button);
    expect(retryFile).toHaveBeenCalledWith(mine.file!.id);
    expect(button).toHaveAttribute("aria-busy", "true");
    act(() => fakeEngine.update({ transfers: { [mine.file!.id]: { state: "transferring", direction: "out", transferred: 300, size: 1234 } } }));
    expect(screen.queryByTestId("voice-retry")).toBeNull();
    expect(screen.getByTestId("voice-progress")).toBeInTheDocument();
  });

  it("a failed note offers Retry only when it can go again: not one the contact cancelled", () => {
    const retryable = voice({ id: "me_r1", sender: "me" });
    retryable.file!.id = "link-1-out-voice-r1";
    const cancelled = voice({ id: "me_r2", sender: "me" });
    cancelled.file!.id = "link-1-out-voice-r2";
    fakeEngine.update({ links: [linkView({ id: "link-1" })], transfers: {
      [retryable.file!.id]: { state: "failed", direction: "out", transferred: 0, size: 1234, error: "Could not read the file: The object can not be found here.", retry: true },
      [cancelled.file!.id]: { state: "failed", direction: "out", transferred: 0, size: 1234, error: "Cancelled by your contact" },
    } });
    chat(retryable, cancelled);
    const [first, second] = bubbles();
    expect(within(first).getByTestId("voice-retry")).toBeInTheDocument();
    expect(within(second).queryByTestId("voice-retry")).toBeNull();
    expect(within(second).getByTestId("voice-status")).toHaveTextContent("· Cancelled");
  });

  it("stuck on its way, it says so instead of a bare 0%, and offers Send again (sent) or Ask again (received)", async () => {
    fakeEngine.on("fileAction", () => undefined);
    const mine = voice({ id: "me_1", sender: "me" });
    mine.file!.id = "link-1-out-voice-stuck";
    const theirs = voice();
    fakeEngine.update({ links: [linkView({ id: "link-1" })], transfers: {
      [mine.file!.id]: { state: "transferring", direction: "out", transferred: 0, size: 1234, stalled: true },
      [theirs.file!.id]: { state: "transferring", direction: "in", stage: "waiting", transferred: 617, size: 1234, stalled: true },
    } });
    chat(mine, theirs);
    const [sent, received] = bubbles();
    expect(within(sent).getByTestId("voice-status")).toHaveTextContent("Not moving · 0% of 1.2 KB");
    expect(within(received).getByTestId("voice-status")).toHaveTextContent("Waiting for connection · 50% done");
    expect(within(sent).getByTestId("voice-resend")).toHaveAttribute("data-tone", "neutral");
    fireEvent.click(within(sent).getByTestId("voice-resend"));
    fireEvent.click(within(received).getByTestId("voice-request"));
    await vi.waitFor(() => expect(fakeEngine.callsTo("fileAction")).toEqual([
      { linkId: "link-1", fileId: mine.file!.id, action: "resend" },
      { linkId: "link-1", fileId: theirs.file!.id, action: "request" },
    ]));
    expect(within(sent).queryByTestId("voice-request")).toBeNull();
  });
});

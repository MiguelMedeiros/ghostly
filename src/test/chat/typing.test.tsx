import { act, fireEvent, screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings as EngineSettings } from "@ghostly/browser/shared/types";
import { MessageInput } from "../../components/MessageInput";
import { Sidebar } from "../../components/Sidebar";
import { ChatSubtitle } from "../../components/TypingIndicator";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { TYPING_IDLE_MS, useTypingSender } from "../../hooks/useTyping";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { Settings } from "../../pages/Settings";
import { engineState, fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.typing, settings.send-typing

const key = (c: string) => c.repeat(52);
const chat = (id: string, over: Partial<ChatSession> = {}): ChatSession =>
  ({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: key(id), encKeyB64: "enc", messages: [], createdAt: 1, ...over });
const typingLink = (typing: boolean) => linkView({ id: "l-a", profile: "paired-chat/1", peerPubKeyZ32: key("a"), ...(typing ? { peerTyping: true } : {}) });

afterEach(() => { vi.useRealTimers(); });

describe("the contact typing", () => {
  it("the header's second line says typing… instead of the key, and back", () => {
    const { engine } = renderApp(<ChatSubtitle peerKey={key("a")} keyLabel="aaaa…aaaa" />);
    act(() => engine.update({ links: [typingLink(false)] }));
    expect(screen.getByTestId("chat-subtitle")).toHaveTextContent("aaaa…aaaa");
    expect(screen.queryByTestId("chat-typing")).not.toBeInTheDocument();
    act(() => engine.update({ links: [typingLink(true)] }));
    expect(screen.getByTestId("chat-typing")).toHaveTextContent("typing…");
    expect(screen.getByTestId("chat-subtitle")).not.toHaveTextContent("aaaa");
    expect(screen.getByTestId("chat-typing")).toHaveClass("text-accent");
    act(() => engine.update({ links: [typingLink(false)] }));
    expect(screen.queryByTestId("chat-typing")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-subtitle")).toHaveTextContent("aaaa…aaaa");
  });

  it("a chat that is not paired never shows it", () => {
    const { engine } = renderApp(<ChatSubtitle keyLabel="aaaa…aaaa" />);
    act(() => engine.update({ links: [typingLink(true)] }));
    expect(screen.queryByTestId("chat-typing")).not.toBeInTheDocument();
  });

  it("the chat list row shows typing… in its preview line, in the accent, then the last message again", () => {
    saveSession(chat("a", { nick: "Alice", nickSource: "profile", messages: [{ id: "m1", text: "see you at eight", sender: "peer", timestamp: Date.now() }] }));
    const { engine } = renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    const row = () => screen.getAllByTestId("chat-row").find(r => within(r).getByTestId("chat-row-name").textContent === "Alice")!;
    act(() => engine.update({ links: [typingLink(true)] }));
    expect(within(row()).getByTestId("chat-row-typing")).toHaveTextContent("typing…");
    expect(within(row()).getByTestId("chat-row-typing")).toHaveClass("text-accent");
    expect(row()).not.toHaveTextContent("see you at eight");
    act(() => engine.update({ links: [typingLink(false)] }));
    expect(within(row()).queryByTestId("chat-row-typing")).not.toBeInTheDocument();
    expect(row()).toHaveTextContent("see you at eight");
  });
});

/** Chat.tsx's composer, wired to tell the engine when this side types. */
function Composer({ linkId = "l-a", active = true }: { linkId?: string; active?: boolean }) {
  const onTyping = useTypingSender(linkId, active);
  return <MessageInput onSend={async () => null} onTyping={onTyping} />;
}

/** What the engine was told, once the calls in flight reached it (a call waits for the connection first). */
const told = async () => {
  await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
  return fakeEngine.callsTo("setTyping").map(c => c.typing);
};
const box = () => screen.getByRole("textbox");

describe("this side typing", () => {
  const answering = () => fakeEngine.on("setTyping", () => undefined);

  it("says typing on a keystroke, at most once a second, and stops when the text is cleared", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    answering();
    renderApp(<Composer />);
    fireEvent.change(box(), { target: { value: "h" } });
    fireEvent.change(box(), { target: { value: "he" } });
    fireEvent.change(box(), { target: { value: "hel" } });
    expect(await told()).toEqual([true]);
    act(() => { vi.advanceTimersByTime(1_000); });
    fireEvent.change(box(), { target: { value: "hell" } });
    expect(await told()).toEqual([true, true]);
    fireEvent.change(box(), { target: { value: "" } });
    expect(await told()).toEqual([true, true, false]);
    // Clearing again says nothing more.
    fireEvent.change(box(), { target: { value: " " } });
    expect(await told()).toEqual([true, true, false]);
  });

  it("stops after a few seconds without a keystroke, even with text left", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    answering();
    renderApp(<Composer />);
    fireEvent.change(box(), { target: { value: "draft" } });
    act(() => { vi.advanceTimersByTime(TYPING_IDLE_MS - 1); });
    expect(await told()).toEqual([true]);
    act(() => { vi.advanceTimersByTime(1); });
    expect(await told()).toEqual([true, false]);
  });

  it("stops when the message is sent", async () => {
    answering();
    const { user } = renderApp(<Composer />);
    await user.type(box(), "hello");
    await user.keyboard("{Enter}");
    const calls = await told();
    expect(calls[calls.length - 1]).toBe(false);
    expect(box()).toHaveValue("");
  });

  it("stops when the chat is left, the page is hidden, or the composer goes", async () => {
    answering();
    const { rerender, unmount } = renderApp(<Composer />);
    fireEvent.change(box(), { target: { value: "a" } });
    rerender(<Composer active={false} />);
    expect(await told()).toEqual([true, false]);
    // Not on screen: keystrokes say nothing.
    fireEvent.change(box(), { target: { value: "ab" } });
    expect(await told()).toEqual([true, false]);
    rerender(<Composer />);
    fireEvent.change(box(), { target: { value: "abc" } });
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    hidden.mockRestore();
    expect(await told()).toEqual([true, false, true, false]);
    fireEvent.change(box(), { target: { value: "abcd" } });
    unmount();
    expect(await told()).toEqual([true, false, true, false, true, false]);
  });
});

describe("Settings: Send typing indicator", () => {
  it("is on by default, with a one-line hint, and switches off and on for this profile", async () => {
    const { user, engine } = renderApp(
      <LockScreenProvider><UpdateProvider><Routes><Route path="/settings" element={<Settings />} /></Routes></UpdateProvider></LockScreenProvider>,
      { route: "/settings" },
    );
    engine.on("updateSettings", ({ settings }) => { act(() => engine.update({ settings: { ...engine.state.settings, ...settings as Partial<EngineSettings> } })); });
    const toggle = screen.getByTestId("settings-send-typing");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveAccessibleName("Send typing indicator");
    expect(screen.getByTestId("settings-send-typing-row")).toHaveTextContent("Contacts see when you're writing. Off, you still see theirs.");
    await user.click(toggle);
    expect(engine.callsTo("updateSettings")).toContainEqual({ settings: { sendTyping: false } });
    expect(await screen.findByTestId("settings-send-typing")).toHaveAttribute("aria-checked", "false");
    await user.click(screen.getByTestId("settings-send-typing"));
    expect(engine.callsTo("updateSettings")).toContainEqual({ settings: { sendTyping: true } });
    expect(engineState().settings.sendTyping).toBeUndefined();
  });
});

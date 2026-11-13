import { act, fireEvent, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceMeta } from "@ghostly/core";
import { MessageInput } from "../../components/MessageInput";
import { LockScreen } from "../../components/LockScreen";
import { LockScreenProvider, useLockScreen } from "../../contexts/LockScreenContext";
import { useChatSearch } from "../../hooks/useChatSearch";
import { handOverUnlock } from "../../lib/lockHandover";
import { activeProfileId } from "../../lib/profiles";
import { hashPassword } from "../../lib/settings";
import { AppProviders, renderApp } from "../render";
import { installFakeAudio, installFakeMedia, media, removeFakeMedia } from "./fakeMedia";

// covers: files.voice.record

const onSend = vi.fn<(text: string) => Promise<string | null>>();
const onSendFile = vi.fn<(file: File, voice?: VoiceMeta) => Promise<string | null>>();
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const mouse = { pointerId: 1, pointerType: "mouse", button: 0, clientX: 300, clientY: 500 };

/** As Root.tsx: the app stays mounted, inert, under the lock screen. */
function App() {
  const { isLocked } = useLockScreen();
  return (
    <div style={{ display: "contents" }} inert={isLocked} aria-hidden={isLocked || undefined}>
      <MessageInput onSend={onSend} onSendFile={onSendFile} />
    </div>
  );
}

const { showModal, close } = HTMLDialogElement.prototype;

beforeEach(async () => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.open = true; };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
  const hash = await hashPassword("right");
  localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: hash, timeoutMinutes: 1 } }));
  handOverUnlock(activeProfileId(), hash);
  vi.useFakeTimers({ shouldAdvanceTime: false });
  installFakeMedia();
  installFakeAudio();
  onSend.mockReset().mockResolvedValue(null);
  onSendFile.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  removeFakeMedia();
  Object.assign(HTMLDialogElement.prototype, { showModal, close });
  localStorage.clear(); sessionStorage.clear();
});

const lockField = () => screen.getByLabelText("Ghostly is locked").querySelector<HTMLInputElement>("input[type=password]")!;

/** A click on the mic, as a mouse makes it: hands-free recording. */
async function recordHandsFree() {
  const mic = screen.getByTestId("voice-record");
  fireEvent.pointerDown(mic, mouse);
  await wait(0);
  fireEvent.pointerUp(mic, mouse);
  fireEvent.click(screen.getByTestId("voice-send"));
  await wait(0);
  expect(screen.getByTestId("voice-bar")).toHaveAttribute("data-mode", "locked");
  expect(media.released()).toBe(false);
}

/** A hands-free recording, then a minute and a bit with nobody touching anything: the app locks. */
async function lockedWhileRecording() {
  renderApp(<LockScreenProvider><LockScreen /><App /></LockScreenProvider>);
  await recordHandsFree();
  await wait(65_000);
  expect(lockField()).toHaveFocus();
  return lockField();
}

describe("a voice recording when the app locks", () => {
  it("stops at once and gives the microphone back", async () => {
    await lockedWhileRecording();
    expect(media.released()).toBe(true);
    expect(screen.queryByTestId("voice-bar")).toBeNull();
  });

  it("is never sent by the keys typed on the lock screen, a wrong password's Enter or the right one's", async () => {
    const field = await lockedWhileRecording();
    fireEvent.change(field, { target: { value: "guess" } });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.keyDown(field, { key: "Escape" });
    await wait(0);
    expect(onSendFile).not.toHaveBeenCalled();
    expect(screen.queryByTestId("voice-confirm")).toBeNull();
    fireEvent.change(field, { target: { value: "right" } });
    fireEvent.submit(field.form!);
    await vi.waitFor(() => expect(screen.queryByLabelText("Ghostly is locked")).toBeNull());
    expect(onSendFile).not.toHaveBeenCalled();
    expect(screen.getByTestId("voice-record")).toHaveAttribute("data-mode", "idle");
  });

  it("does not take an Enter typed inside a dialog it is not in", async () => {
    renderApp(<LockScreenProvider><App /></LockScreenProvider>);
    await recordHandsFree();
    const dialog = document.body.appendChild(document.createElement("dialog"));
    dialog.open = true;
    const input = dialog.appendChild(document.createElement("input"));
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Escape" });
    await wait(0);
    expect(onSendFile).not.toHaveBeenCalled();
    expect(screen.getByTestId("voice-bar")).toHaveAttribute("data-mode", "locked");
    dialog.remove();
  });

  // Message details, the connection panel and most of the app's panels are a `role="dialog"` box, not a `<dialog>`; a
  // message's ⋮ menu is a group of buttons.
  it.each([
    ["a modal panel", { role: "dialog", "aria-modal": "true" }],
    ["a popover panel", { role: "dialog" }],
    ["a message's menu", { role: "group", "data-menu": "popover" }],
  ])("does not take an Enter or an Escape typed inside %s it is not in", async (_name, attributes) => {
    renderApp(<LockScreenProvider><App /></LockScreenProvider>);
    await recordHandsFree();
    // Long enough to send, and for an Escape to ask first.
    await wait(4_000);
    const panel = document.body.appendChild(document.createElement("div"));
    for (const [name, value] of Object.entries(attributes)) panel.setAttribute(name, value);
    const button = panel.appendChild(document.createElement("button"));
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.keyDown(button, { key: "Escape" });
    await wait(0);
    expect(onSendFile).not.toHaveBeenCalled();
    expect(screen.queryByTestId("voice-confirm")).toBeNull();
    expect(screen.getByTestId("voice-bar")).toHaveAttribute("data-mode", "locked");
    panel.remove();
  });

  it("still answers Escape on its own discard question, where the focus is", async () => {
    renderApp(<LockScreenProvider><App /></LockScreenProvider>);
    await recordHandsFree();
    await wait(4_000);
    fireEvent.keyDown(document.body, { key: "Escape" });
    await wait(0);
    const keep = screen.getByTestId("voice-confirm-keep");
    expect(keep).toHaveFocus();
    fireEvent.keyDown(keep, { key: "Escape" });
    await wait(0);
    expect(screen.queryByTestId("voice-confirm")).toBeNull();
    expect(screen.getByTestId("voice-bar")).toHaveAttribute("data-mode", "locked");
  });
});

describe("Ctrl/Cmd+F while the app is locked", () => {
  it("does not open the chat's search behind the lock", async () => {
    const wrapper = ({ children }: { children: ReactNode }) => <AppProviders><LockScreenProvider>{children}</LockScreenProvider></AppProviders>;
    const { result } = renderHook(() => ({ search: useChatSearch({ messages: [], chat: "chat-1", active: true }), screen: useLockScreen() }), { wrapper });
    act(() => result.current.screen.lock());
    expect(result.current.screen.isLocked).toBe(true);
    const event = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, cancelable: true });
    act(() => { window.dispatchEvent(event); });
    expect(result.current.search.open).toBe(false);
  });
});

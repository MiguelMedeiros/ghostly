import "fake-indexeddb/auto";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import { CueChat } from "../../lib/cues";
import { groupChat, setChatMute, mutedUntil } from "../../lib/chatMute";
import { forgetGroupLocal } from "../../lib/groups";
import { createProfile, namespaceOf } from "../../lib/profiles";
import { createProfileBackup, restoreProfileBackup } from "../../lib/profileBackup";
import {
  KEPT_ORIGINALS, KEPT_ORIGINAL_CHARS, forgetSentOriginal, forgetSentOriginals, keepSentOriginal, originalMentions, sentOriginal, setShowsOriginal,
} from "../../lib/sentOriginals";
import { deleteSession, saveSession, setStorageProfile } from "../../lib/storage";
import type { ChatMessage } from "../../lib/types";
import { renderApp } from "../render";

const WIRE = "A".repeat(22);
const ID = `me_${WIRE}`;
/** An old message of mine (history: no entry animation), as the contact got it: the translation. */
const mine = (patch: Partial<ChatMessage> = {}): ChatMessage => ({ id: ID, text: "Ci vediamo domani alle sei", sender: "me", timestamp: 1_700_000_000_000, ...patch });
const ORIGINAL = { to: "it", original: "See you tomorrow at six" };

const bubble = (message: ChatMessage, chat = "s1") => (
  <CueChat.Provider value={chat}><MessageBubble message={message} peerPubKey="peer" onReact={() => {}} /></CueChat.Provider>
);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
  setShowsOriginal("s1", ID, false);
  setStorageProfile("");
});

describe("the originals of my sent translations, on this device", () => {
  it("are kept by chat and message, under the profile's prefix", () => {
    keepSentOriginal("s1", ID, ORIGINAL);
    expect(sentOriginal("s1", ID)).toEqual(ORIGINAL);
    expect(sentOriginal("s2", ID)).toBeUndefined();
    expect(localStorage.getItem("ghostly_sent_originals_s1")).not.toBeNull();
    const work = createProfile("Work");
    setStorageProfile(namespaceOf(work.id));
    expect(sentOriginal("s1", ID)).toBeUndefined();
  });

  it("go with their message, and with their chat", () => {
    keepSentOriginal("s1", ID, ORIGINAL);
    keepSentOriginal("s1", "me_other", { to: "it", original: "Hello" });
    forgetSentOriginal("s1", ID);
    expect(sentOriginal("s1", ID)).toBeUndefined();
    expect(sentOriginal("s1", "me_other")).toBeDefined();
    forgetSentOriginals("s1");
    expect(localStorage.getItem("ghostly_sent_originals_s1")).toBeNull();
  });

  it("go when the 1:1 chat is deleted, or the group left", () => {
    saveSession({ id: "s1", messages: [], createdAt: 1 } as unknown as Parameters<typeof saveSession>[0]);
    keepSentOriginal("s1", ID, ORIGINAL);
    deleteSession("s1");
    expect(sentOriginal("s1", ID)).toBeUndefined();
    keepSentOriginal(groupChat("g1"), ID, ORIGINAL);
    forgetGroupLocal("g1");
    expect(sentOriginal(groupChat("g1"), ID)).toBeUndefined();
  });

  it("keep at most the newest ones of a chat, by count and by size", () => {
    for (let i = 0; i <= KEPT_ORIGINALS; i++) keepSentOriginal("s1", `m${i}`, { to: "it", original: `text ${i}` });
    expect(sentOriginal("s1", "m0")).toBeUndefined();
    expect(sentOriginal("s1", "m1")).toBeDefined();
    expect(sentOriginal("s1", `m${KEPT_ORIGINALS}`)).toBeDefined();
    const big = "x".repeat(KEPT_ORIGINAL_CHARS / 2);
    keepSentOriginal("s2", "a", { to: "it", original: big });
    keepSentOriginal("s2", "b", { to: "it", original: big });
    keepSentOriginal("s2", "c", { to: "it", original: big });
    expect(["a", "b", "c"].map((id) => !!sentOriginal("s2", id))).toEqual([false, true, true]);
  });

  it("are never in a backup: the restored profile has the chat's mute, not the originals", async () => {
    const work = createProfile("Work");
    setStorageProfile(namespaceOf(work.id));
    keepSentOriginal("s1", ID, ORIGINAL);
    setChatMute("s1", "forever");
    const back = await restoreProfileBackup(await createProfileBackup("a long backup passphrase", work.id), "a long backup passphrase");
    setStorageProfile(namespaceOf(back.id));
    expect(mutedUntil("s1")).toBe("forever");
    expect(sentOriginal("s1", ID)).toBeUndefined();
  });
});

describe("my translated bubble", () => {
  it("says what it was translated to, and Show original swaps the text in place and back", async () => {
    vi.stubEnv("VITE_TRANSLATE", "1");
    keepSentOriginal("s1", ID, ORIGINAL);
    const { user } = renderApp(bubble(mine()));
    const line = screen.getByTestId("message-sent-translation");
    expect(line).toHaveTextContent("Translated to Italian · Show original");
    expect(screen.getByTestId("message-text")).toHaveTextContent("Ci vediamo domani alle sei");
    const toggle = within(line).getByRole("button", { name: "Show original" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);
    expect(screen.getByTestId("message-text")).toHaveTextContent("See you tomorrow at six");
    expect(toggle).toHaveTextContent("Show translation");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await user.click(toggle);
    expect(screen.getByTestId("message-text")).toHaveTextContent("Ci vediamo domani alle sei");
  });

  it("in a group, the original shows its mentions where they fall in it, not at the translation's places", async () => {
    vi.stubEnv("VITE_TRANSLATE", "1");
    const ann = "k".repeat(52);
    keepSentOriginal(groupChat("g1"), ID, { to: "it", original: "hi @Ann how are you" });
    const message = mine({ text: "ciao @Ann come stai", mentions: [{ o: 5, l: 4, key: ann, name: "Ann", me: false }] });
    const { user } = renderApp(bubble(message, groupChat("g1")));
    expect(screen.getByTestId("message-text")).toHaveTextContent("ciao @Ann come stai");
    await user.click(screen.getByTestId("message-show-original"));
    expect(screen.getByTestId("message-text")).toHaveTextContent(/^hi @Ann how are you$/);
    expect(within(screen.getByTestId("message-text")).getByTestId("mention")).toHaveTextContent("@Ann");
    setShowsOriginal(groupChat("g1"), ID, false);
  });

  it("a mention the original does not have reads as plain text there", () => {
    const ann = { o: 5, l: 4, key: "k".repeat(52), name: "Ann", me: false };
    expect(originalMentions("hi @Ann how are you", "ciao @Ann come stai", [ann])).toEqual([{ ...ann, o: 3, l: 4 }]);
    expect(originalMentions("hi Ann how are you", "ciao @Ann come stai", [ann])).toEqual([]);
    expect(originalMentions("hi", "ciao", undefined)).toBeUndefined();
  });

  it("remembers Show original for the message while the app runs", async () => {
    vi.stubEnv("VITE_TRANSLATE", "1");
    keepSentOriginal("s1", ID, ORIGINAL);
    const first = renderApp(bubble(mine()));
    await first.user.click(screen.getByTestId("message-show-original"));
    first.unmount();
    renderApp(bubble(mine()));
    expect(screen.getByTestId("message-text")).toHaveTextContent("See you tomorrow at six");
  });

  it("shows the line once the send path keeps the original", () => {
    vi.stubEnv("VITE_TRANSLATE", "1");
    renderApp(bubble(mine()));
    expect(screen.queryByTestId("message-sent-translation")).not.toBeInTheDocument();
    act(() => keepSentOriginal("s1", ID, ORIGINAL));
    expect(screen.getByTestId("message-sent-translation")).toBeInTheDocument();
  });

  it("shows nothing new without the build flag, on another device's copy, a received message or an edited one", () => {
    keepSentOriginal("s1", ID, ORIGINAL);
    const off = renderApp(bubble(mine()));
    expect(screen.queryByTestId("message-sent-translation")).not.toBeInTheDocument();
    off.unmount();
    vi.stubEnv("VITE_TRANSLATE", "1");
    for (const message of [mine({ id: "me_elsewhere" }), mine({ sender: "peer" }), mine({ edit: { at: 1_700_000_100_000 } as ChatMessage["edit"] })]) {
      const view = renderApp(bubble(message));
      expect(screen.queryByTestId("message-sent-translation")).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it("a finger held on it copies the sent text, and offers the original as a second item", () => {
    vi.stubEnv("VITE_TRANSLATE", "1");
    keepSentOriginal("s1", ID, ORIGINAL);
    vi.useFakeTimers();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const hold = (container: HTMLElement) => {
      const row = container.querySelector<HTMLElement>("[data-message-row]")!;
      fireEvent.pointerDown(row, { pointerType: "touch", button: 0, clientX: 20, clientY: 20, pointerId: 1 });
      act(() => { vi.advanceTimersByTime(600); });
      fireEvent.pointerUp(row, { pointerType: "touch", clientX: 20, clientY: 20, pointerId: 1 });
    };
    const { container } = renderApp(bubble(mine()));
    hold(container);
    const rows = within(screen.getByTestId("reaction-bar")).getAllByRole("button").map(b => b.dataset.testid).filter(id => id?.startsWith("reaction-bar-"));
    expect(rows).toEqual(["reaction-bar-copy", "reaction-bar-copy-original", "reaction-bar-details"]);
    expect(screen.getByTestId("reaction-bar-copy-original")).toHaveTextContent("Copy original");
    fireEvent.click(screen.getByTestId("reaction-bar-copy"));
    expect(writeText).toHaveBeenLastCalledWith("Ci vediamo domani alle sei");
    hold(container);
    fireEvent.click(screen.getByTestId("reaction-bar-copy-original"));
    expect(writeText).toHaveBeenLastCalledWith("See you tomorrow at six");
  });
});

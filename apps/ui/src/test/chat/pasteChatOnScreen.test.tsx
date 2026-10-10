// happy-dom has no IndexedDB: the file store keeps what is sent in this one.
import "fake-indexeddb/auto";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageInput } from "../../components/MessageInput";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { Chat } from "../../pages/Chat";
import { saveSession } from "../../lib/storage";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.composer.paste-files

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

const onSend = vi.fn<(text: string) => Promise<string | null>>();
const toBehind = vi.fn<(file: File) => Promise<string | null>>();
const toShown = vi.fn<(file: File) => Promise<string | null>>();

const png = () => new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" });
/** What a clipboard hands the page: jsdom-likes have no DataTransfer to build one with. */
const clipboard = (file: File) => ({ files: [file], types: ["Files"], items: [{ kind: "file", type: file.type, getAsFile: () => file }], getData: () => "", dropEffect: "none" });
const sheets = () => screen.queryAllByTestId("attachment-sheet");

/** A paste made with no field focused: the chat's messages were clicked last. */
function pasteOutsideFields(target: Element) {
  act(() => (document.activeElement as HTMLElement | null)?.blur());
  return fireEvent.paste(target, { clipboardData: clipboard(png()) });
}

beforeEach(() => {
  onSend.mockReset().mockResolvedValue(null);
  toBehind.mockReset().mockResolvedValue(null);
  toShown.mockReset().mockResolvedValue(null);
  URL.createObjectURL = vi.fn(() => "blob:picture");
  URL.revokeObjectURL = vi.fn();
  localStorage.clear();
});

describe("a chat kept loaded behind the one on screen (a call under way, an app running in it)", () => {
  it("leaves a paste made with no field focused to the composer on screen", async () => {
    // As App.tsx lays its loaded chats out: the one loaded first is hidden, the one being read is shown.
    const { user } = renderApp(<LockScreenProvider>
      <div className="hidden"><MessageInput onSend={onSend} onSendFile={toBehind} onScreen={false} /></div>
      <div><p data-testid="messages">messages</p><MessageInput onSend={onSend} onSendFile={toShown} /></div>
    </LockScreenProvider>);
    pasteOutsideFields(screen.getByTestId("messages"));
    await waitFor(() => expect(sheets()).toHaveLength(1));
    await user.click(within(sheets()[0]!).getByTestId("attachment-send"));
    await waitFor(() => expect(toShown).toHaveBeenCalledTimes(1));
    expect(toBehind).not.toHaveBeenCalled();
  });

  it("takes no paste while no chat is on screen, and takes it again once it is the one shown", async () => {
    const composer = (onScreen: boolean) => <LockScreenProvider><p data-testid="page">another page</p><MessageInput onSend={onSend} onSendFile={toBehind} onScreen={onScreen} /></LockScreenProvider>;
    const { rerender } = renderApp(composer(false));
    // Left alone: the page does what it does with a paste nobody takes.
    expect(pasteOutsideFields(screen.getByTestId("page"))).toBe(true);
    expect(sheets()).toHaveLength(0);
    rerender(composer(true));
    expect(pasteOutsideFields(screen.getByTestId("page"))).toBe(false);
    await waitFor(() => expect(sheets()).toHaveLength(1));
  });

  it("two chats loaded: the picture goes to the contact of the chat on screen", async () => {
    const BEHIND = "behind".padEnd(52, "b"), SHOWN = "shown".padEnd(52, "s");
    saveSession({ id: "chat-behind", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: BEHIND, encKeyB64: "a2V5", messages: [], createdAt: 1_700_000_000_000 });
    saveSession({ id: "chat-shown", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: SHOWN, encKeyB64: "a2V5", messages: [], createdAt: 1_700_000_000_001 });
    const { user, engine } = renderApp(<>
      <div className="hidden"><Chat sessionId="chat-behind" visible={false} onCallChange={() => {}} callLayer={null} /></div>
      <div data-testid="shown"><Chat sessionId="chat-shown" visible onCallChange={() => {}} callLayer={null} /></div>
    </>);
    engine.on("sendFile", () => undefined).update({ links: [BEHIND, SHOWN].map((peerPubKeyZ32) => linkView({ id: `link-${peerPubKeyZ32}`, peerPubKeyZ32, profile: "paired-chat/1", capabilities: { files: true } } as never)) });
    await waitFor(() => expect(screen.getAllByPlaceholderText("Message…")).toHaveLength(2));
    pasteOutsideFields(screen.getByTestId("shown"));
    await waitFor(() => expect(sheets()).toHaveLength(1));
    await user.click(within(sheets()[0]!).getByTestId("attachment-send"));
    await waitFor(() => expect(engine.callsTo("sendFile")).toHaveLength(1));
    expect(engine.callsTo("sendFile").map((call) => call.linkId)).toEqual([`link-${SHOWN}`]);
  });
});

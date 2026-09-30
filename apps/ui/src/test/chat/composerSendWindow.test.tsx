import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { saveSession, setStorageProfile as setProfile } from "../../lib/storage";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.paired.send

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

const PEER = "peer".padEnd(52, "p");

/**
 * A 1:1 chat's composer stays open while a message goes. On a chat that is not live the engine answers only once the
 * DHT publication is done, seconds later; the field was disabled all that time, so what a fast typist wrote next,
 * and its Enter, went nowhere.
 */
function openChat() {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", messages: [], createdAt: 1_700_000_000_000 });
  const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
  const pending: (() => void)[] = [];
  utils.engine.on("sendMessage", () => new Promise((resolve) => { pending.push(() => resolve({ error: null })); }))
    .update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1" } as never)] });
  const finish = async () => { await act(async () => { pending.shift()!(); }); };
  return { ...utils, pending, finish };
}

const field = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message…");
const sentTexts = (engine: ReturnType<typeof openChat>["engine"]) => engine.callsTo("sendMessage").map((c) => (c as { text: string }).text);

afterEach(() => { localStorage.clear(); setProfile(""); });

describe("typing on while a message goes (a 1:1 chat)", () => {
  it("the field stays open, and the next message typed with its Enter goes after the first", async () => {
    const { user, engine, pending, finish } = openChat();
    await user.click(await screen.findByPlaceholderText("Message…"));
    await user.keyboard("ok{Enter}");
    await waitFor(() => expect(pending).toHaveLength(1));
    // Still publishing: the field takes the next message.
    expect(field()).toBeEnabled();
    await user.keyboard("see you there{Enter}");
    // The words on their way leave the field once they have gone; what was typed after them stays and goes next.
    expect(field().value).toMatch(/see you there$/);
    expect(sentTexts(engine)).toEqual(["ok"]);
    await finish();
    await waitFor(() => expect(sentTexts(engine)).toEqual(["ok", "see you there"]));
    await finish();
    await waitFor(() => expect(field()).toHaveValue(""));
    expect(field()).toHaveFocus();
  });

  it("words typed with no Enter stay in the field once the first has gone", async () => {
    const { user, engine, pending, finish } = openChat();
    await user.click(await screen.findByPlaceholderText("Message…"));
    await user.keyboard("ok{Enter}");
    await waitFor(() => expect(pending).toHaveLength(1));
    await user.keyboard("and");
    await finish();
    await waitFor(() => expect(field()).toHaveValue("and"));
    expect(sentTexts(engine)).toEqual(["ok"]);
  });
});

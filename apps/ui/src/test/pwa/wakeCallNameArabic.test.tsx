import "fake-indexeddb/auto";
import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { saveSession } from "../../lib/storage";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: push.wake.call, app.i18n

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

const PEER = "peer".padEnd(52, "p");

/**
 * Calling a contact whose app is closed, in Arabic: "Waking Ana (2) for the call…" and "Ana (2) did not open Ghostly."
 * put the contact's name in plainly, so its bracket group took the sentence's right-to-left direction and was drawn on
 * the other side of the Latin name ("(2) Ana"), and a Latin name ran into "Ghostly" after it as one left-to-right run.
 * Each is its own <bdi> now, as the call's other notices have it.
 */
describe("the wake-up notice of a call, in Arabic", () => {
  it.each([
    [true, "waking", "جارٍ إيقاظ Ana (2) للمكالمة…"],
    [false, "gave-up", "لم يفتح Ana (2) Ghostly."],
  ])("isolates the contact's name (woken: %s)", async (woken, state, text) => {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana (2)", messages: [], createdAt: 1_700_000_000_000 });
    const { user, engine } = renderApp(<Chat sessionId="chat-1" onCallChange={vi.fn()} callLayer={null} visible />, { language: "ar" });
    engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("wakeForCall", () => woken);
    act(() => engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "connecting" }, dataLink: "idle", peerWakes: true } as never)] }));

    await user.click(await screen.findByTestId("call-audio"));
    const notice = await screen.findByTestId("wake-call");
    expect(notice).toHaveAttribute("data-state", state);
    expect(notice).toHaveTextContent(text);
    expect([...notice.querySelectorAll("bdi")].map((bdi) => bdi.textContent)).toEqual(["Ana (2)"]);
  });
});

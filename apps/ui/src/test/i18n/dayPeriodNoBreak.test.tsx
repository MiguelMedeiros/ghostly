import "fake-indexeddb/auto";
import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { saveSession } from "../../lib/storage";
import { clockTime, formatAt } from "../../lib/time";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.i18n

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

const PEER = "peer".padEnd(52, "p");
const MORNING = Date.UTC(2026, 0, 5, 9, 41), EVENING = Date.UTC(2026, 0, 5, 21, 41);

/** A plain space beside "ص" or "م": a line may break there and leave the day period alone on the next line. */
const breakable = /[0-9٠-٩] [صم]/;

/**
 * Arabic writes a time with a plain space before its day period ("9:41 م"), so the "Chat created …" line on a narrow
 * phone broke between the two: "9:41" ended one line and "م" began the next. English gets a narrow no-break space from
 * the browser and never split. The time and its day period are held together with a no-break space now.
 */
describe("an Arabic time keeps its day period on its line", () => {
  it.each([MORNING, EVENING])("in formatAt and clockTime (%s)", (at) => {
    for (const text of [formatAt(at, { dateStyle: "medium", timeStyle: "short" }, "ar"), formatAt(at, { timeStyle: "medium" }, "ar"), clockTime(at, "ar")]) {
      expect(text).toMatch(/\u00a0[صم]$/);
      expect(text).not.toMatch(breakable);
    }
  });

  it("other languages read as before", () => {
    const options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" };
    expect(formatAt(EVENING, options, "en")).toBe(new Intl.DateTimeFormat("en", options).format(EVENING));
    expect(formatAt(EVENING, options, "pt")).toBe(new Intl.DateTimeFormat("pt-BR", options).format(EVENING));
    expect(clockTime(EVENING, "ja")).toBe(new Intl.DateTimeFormat("ja", { hour: "2-digit", minute: "2-digit" }).format(EVENING));
  });

  it("on the chat's \"Chat created\" line", async () => {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: EVENING });
    const { engine } = renderApp(<Chat sessionId="chat-1" onCallChange={vi.fn()} callLayer={null} visible />, { language: "ar" });
    act(() => engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1" } as never)] }));
    const line = (await screen.findByTestId("chat-created")).textContent!;
    expect(line).toMatch(/\u00a0م/);
    expect(line).not.toMatch(breakable);
  });
});

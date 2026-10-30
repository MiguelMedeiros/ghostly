// covers: calls.paired, calls.paired.live-only
import { describe, expect, it } from "vitest";
import { callEventText, callLineId, callsBlockedText } from "../../lib/callLines";
import { english } from "../../lib/english";
import { addMessage, addMissedCall, callLineCount, getUnreadCount, loadSession, markSessionAsRead, MAX_CALL_LINE_COUNT, MISSED_BURST_MS, saveSession, uncountMissedCall } from "../../lib/storage";
import type { ChatMessage, ChatSession } from "../../lib/types";
import { translateWith } from "../../locales/translate";
import { LANGUAGES, LOCALES } from "../i18n/locales";

const chat: ChatSession = { id: "c", profile: "paired-chat/1", mySeedB64: "seed", peerPubKeyB64: "key", encKeyB64: "enc", messages: [], createdAt: 0 };
const line = (id: string): ChatMessage => ({ id, text: "Incoming video call", sender: "system", timestamp: 1, callEvent: { type: "call_received", hasVideo: true } });

describe("a call's lines in the history", () => {
  it("one ringing offer, heard again after the app reopened, keeps one Incoming line", () => {
    saveSession({ ...chat, messages: [] });
    addMessage("c", line(callLineId("call_received", 1790000000000)));
    addMessage("c", line(callLineId("call_received", 1790000000000)));
    expect(loadSession("c")!.messages).toHaveLength(1);
    // Another call is another line.
    addMessage("c", line(callLineId("call_received", 1790000060000)));
    expect(loadSession("c")!.messages).toHaveLength(2);
  });

  it("a line with no call to key it gets an id of its own", () => {
    expect(callLineId("call_ended")).not.toBe(callLineId("call_ended"));
    expect(callLineId("call_missed", 5)).not.toBe(callLineId("call_received", 5));
  });
});

// A contact who rang and hung up over and over left a line per call: a burst of them is to be one line, "12 missed
// calls" (the next slice writes it). The stored line says how many it stands for; one written before says nothing.
describe("a call's line that stands for several calls", () => {
  const missed = (id: string, count?: unknown): ChatMessage =>
    ({ id, text: "Missed audio call", sender: "system", timestamp: 2, callEvent: { type: "call_missed", hasVideo: false, ...(count !== undefined ? { count: count as number } : {}) } });

  it("keeps its count through the stored copy, and a line without one stands for one call", () => {
    saveSession({ ...chat, messages: [] });
    addMessage("c", missed("system_call_call_missed_1", 12));
    addMessage("c", missed("system_call_call_missed_2"));
    const [many, one] = loadSession("c")!.messages;
    expect(many!.callEvent).toEqual({ type: "call_missed", hasVideo: false, count: 12 });
    expect(callLineCount(many!.callEvent)).toBe(12);
    expect(one!.callEvent!.count).toBeUndefined();
    expect(callLineCount(one!.callEvent)).toBe(1);
  });

  it("reads anything but a whole number of two or more as one call, and never more than its bound", () => {
    for (const count of [undefined, 0, 1, -3, 2.5, Number.NaN, Infinity, "12", null]) expect(callLineCount({ count }), String(count)).toBe(1);
    expect(callLineCount(undefined)).toBe(1);
    expect(callLineCount({ count: 2 })).toBe(2);
    expect(callLineCount({ count: 1e9 })).toBe(MAX_CALL_LINE_COUNT);
  });

  it("counts each call it stands for as unread, as the lines it replaces did", () => {
    saveSession({ ...chat, messages: [] });
    markSessionAsRead("c");
    addMessage("c", missed("system_call_call_missed_1", 12));
    addMessage("c", missed("system_call_call_missed_2"));
    expect(getUnreadCount(loadSession("c")!)).toBe(13);
    // A received line with a count (none is written so) is no missed call: nothing unread.
    addMessage("c", { ...missed("system_call_call_received_3", 4), callEvent: { type: "call_received", count: 4 } });
    expect(getUnreadCount(loadSession("c")!)).toBe(13);
    markSessionAsRead("c");
    expect(getUnreadCount(loadSession("c")!)).toBe(0);
  });
});

// agents#992 slice 2: a contact who rang and hung up over and over left "Incoming audio call" + "Missed audio call" per
// call (pw/calls10.spec.ts spam200: 1,375 calls a minute). A burst is one line, "12 missed audio calls".
describe("a burst of missed calls from the contact", () => {
  const at = 1_790_000_000_000;
  const rung = (ts: number, hasVideo = false): ChatMessage =>
    ({ id: callLineId("call_received", ts), text: "Incoming audio call", sender: "system", timestamp: ts, callEvent: { type: "call_received", hasVideo } });
  const missed = (ts: number, hasVideo = false): ChatMessage =>
    ({ id: callLineId("call_missed", ts), text: hasVideo ? "Missed video call" : "Missed audio call", sender: "system", timestamp: ts + 500, callEvent: { type: "call_missed", hasVideo } });
  /** What the chat does for one call that rang and was missed (Chat.tsx `addCallEventMessage`), or was held unrung. */
  const call = (ts: number, { rings = true, hasVideo = false, seen = false } = {}) => {
    if (rings) addMessage("c", rung(ts, hasVideo));
    return addMissedCall("c", missed(ts, hasVideo), { rang: rings ? callLineId("call_received", ts) : undefined, seen });
  };
  const shown = () => loadSession("c")!.messages.map((m) => `${m.callEvent?.type}:${callLineCount(m.callEvent)}`);

  it("is one line that counts them, rung or held, with no Incoming line left", () => {
    saveSession({ ...chat, messages: [] });
    markSessionAsRead("c");
    for (let i = 0; i < 12; i++) call(at + i * 3_000, { rings: i % 3 === 0 });
    expect(shown()).toEqual(["call_missed:12"]);
    const [line] = loadSession("c")!.messages;
    expect(line!.text).toBe("12 missed audio calls");
    expect(line!.timestamp, "the line moves to the last call").toBe(at + 11 * 3_000 + 500);
    expect(getUnreadCount(loadSession("c")!), "each call is unread, as before").toBe(12);
  });

  it("the same call heard again (the app reopened) is not counted twice", () => {
    saveSession({ ...chat, messages: [] });
    call(at);
    call(at + 3_000);
    call(at + 3_000);
    addMissedCall("c", missed(at + 3_000));
    expect(shown()).toEqual(["call_missed:2"]);
  });

  it("starts a line of its own after a message, another kind of call, a pause, or a line the person read", () => {
    saveSession({ ...chat, messages: [] });
    call(at);
    addMessage("c", { id: "peer_1", text: "hi", sender: "peer", timestamp: at + 2_000 });
    call(at + 3_000);
    call(at + 6_000, { hasVideo: true });
    call(at + 6_000 + MISSED_BURST_MS + 1_000, { hasVideo: true });
    expect(shown()).toEqual(["call_received:1", "call_missed:1", "undefined:1", "call_received:1", "call_missed:1", "call_received:1", "call_missed:1", "call_received:1", "call_missed:1"]);

    saveSession({ ...chat, messages: [] });
    call(at, { rings: false });
    markSessionAsRead("c");
    call(at + 3_000, { rings: false });
    expect(shown(), "read while away: the next call is news").toEqual(["call_missed:1", "call_missed:1"]);
    call(at + 6_000, { rings: false, seen: true });
    expect(shown(), "on screen: it counts on the line being looked at").toEqual(["call_missed:1", "call_missed:2"]);
  });

  it("a read line taken away moves the read mark with it, so nothing reads as unread twice", () => {
    saveSession({ ...chat, messages: [] });
    call(at, { seen: true });
    markSessionAsRead("c");
    call(at + 3_000, { seen: true });
    expect(shown()).toEqual(["call_missed:2"]);
    expect(getUnreadCount(loadSession("c")!)).toBe(0);
  });

  it("a call taken back off the line (a held call that rang after all) is one less", () => {
    saveSession({ ...chat, messages: [] });
    const { line } = call(at)!;
    call(at + 3_000, { rings: false });
    call(at + 6_000, { rings: false });
    uncountMissedCall("c", line);
    expect(shown()).toEqual(["call_missed:2"]);
    uncountMissedCall("c", line);
    expect(loadSession("c")!.messages[0]!.callEvent).toEqual({ type: "call_missed", hasVideo: false });
    expect(loadSession("c")!.messages[0]!.text).toBe("Missed audio call");
    expect(uncountMissedCall("c", line), "a line of one call is left as it is").toBeNull();
  });

  it.each(LANGUAGES)("says how many in %s, and a line of one as before", (language) => {
    const t = translateWith(LOCALES[language], language);
    for (const hasVideo of [false, true]) {
      const many = callEventText(t, "call_missed", hasVideo, 12)!;
      expect(many).toContain("12");
      expect(many).not.toBe(callEventText(t, "call_missed", hasVideo));
      expect(callEventText(t, "call_missed", hasVideo, 1)).toBe(callEventText(t, "call_missed", hasVideo));
    }
    expect(callEventText(t, "call_received", false, 12), "only a missed line counts").toBe(callEventText(t, "call_received", false));
  });
});

describe("why a chat's call buttons are off", () => {
  // As the engine says them (packages/core ghostlink.ts `callsUnavailable`, packages/browser engine/node.ts linkView).
  const REASONS = ["Calls need a live connection", "Your contact's app cannot take calls", "Your contact needs an updated Ghostly for calls", "Calls are not available in this app"];

  it("is nothing while the chat can call", () => {
    expect(callsBlockedText(english, null)).toBeNull();
  });

  it("is that calls need a live connection before the engine has said anything", () => {
    expect(callsBlockedText(english, undefined)).toBe("Calls need a live connection");
    expect(callsBlockedText(translateWith(LOCALES.pt, "pt"), undefined)).toBe("Chamadas precisam de uma conexão direta");
  });

  it("is the engine's reason as it is in English", () => {
    for (const reason of REASONS) expect(callsBlockedText(english, reason)).toBe(reason);
  });

  it.each(LANGUAGES.filter((l) => l !== "en"))("is said in %s, not in the engine's English", (language) => {
    const t = translateWith(LOCALES[language], language);
    expect(REASONS.filter((reason) => callsBlockedText(t, reason) === reason)).toEqual([]);
    // The contact not being connected is the same sentence whether the engine said it or has not said anything yet.
    expect(callsBlockedText(t, "Calls need a live connection")).toBe(callsBlockedText(t, undefined));
  });

  it("is what the Desktop app says is missing, as it came: it names what to install", () => {
    const missing = "Calls need GStreamer plugins that are not installed: opusenc (gst-plugins-base), webrtcdsp (gst-plugins-bad)";
    expect(callsBlockedText(translateWith(LOCALES.pt, "pt"), missing)).toBe(missing);
  });
});

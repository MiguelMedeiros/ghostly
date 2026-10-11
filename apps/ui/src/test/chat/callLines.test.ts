// covers: calls.paired, calls.paired.live-only
import { describe, expect, it } from "vitest";
import { callLineId, callsBlockedText } from "../../lib/callLines";
import { english } from "../../lib/english";
import { addMessage, loadSession, saveSession } from "../../lib/storage";
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

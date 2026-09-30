// covers: calls.paired
import { describe, expect, it } from "vitest";
import { callLineId } from "../../lib/callLines";
import { addMessage, loadSession, saveSession } from "../../lib/storage";
import type { ChatMessage, ChatSession } from "../../lib/types";

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

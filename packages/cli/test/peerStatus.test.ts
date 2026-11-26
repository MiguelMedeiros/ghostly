import type { LinkView } from "@ghostly/browser/shared/types";
import { describe, expect, it } from "vitest";
import { chatDetailsJson, chatJson } from "../src/views";
// covers: headless.presence

const link = (fields: Partial<LinkView> = {}) => ({ id: "c", peerPubKeyZ32: "pc", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", textDelivery: "stream", pairing: { status: "ready" }, ...fields }) as unknown as LinkView;

describe("a contact's status and presence in chat show and chat list", () => {
  it("carry the status the contact set, every field, and their presence when they share it", () => {
    const until = Date.now() + 2 * 3_600_000;
    const chat = link({ peerStatus: { availability: "busy", emoji: "🍕", text: "At lunch", until }, peerPresence: "idle" });
    expect(chatJson(chat)).toMatchObject({ status: { text: "At lunch", emoji: "🍕", availability: "busy", until }, presence: "idle" });
    expect(chatDetailsJson(chat)).toMatchObject({ status: { availability: "busy" }, presence: "idle" });
    expect(chatJson(link({ peerStatus: { availability: "dnd" } })).status).toEqual({ text: null, emoji: null, availability: "dnd", until: null });
  });

  it("are null when the contact set none, its end is past, or they do not share when they are online", () => {
    expect(chatJson(link())).toMatchObject({ status: null, presence: null });
    expect(chatJson(link({ peerStatus: { text: "Back at 2", until: Date.now() - 1 } })).status).toBeNull();
  });
});

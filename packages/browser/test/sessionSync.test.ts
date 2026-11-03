import { expect, it, vi } from "vitest";
import { toChatMessage } from "../src/platform/sync";
vi.mock("../src/platform/engine", () => ({ engine: {} }));
// covers: chat.paired.join-notice, chat.order

it("attributes each join announcement to its actual sender", () => {
  const common = { linkId: "chat", text: "👋 Casper joined", timestamp: 1, via: "datalink" as const };
  const mine = toChatMessage({ ...common, id: "me_join", sender: "me", delivery: "delivered" }, "peer", "mine");
  const theirs = toChatMessage({ ...common, id: "peer_join", sender: "peer", joinLine: true }, "peer", "mine");
  expect(mine.systemEvent).toEqual({ type: "join", pubKey: "mine" });
  expect(theirs.systemEvent).toEqual({ type: "join", pubKey: "peer" });
});

it("draws a row of the contact's as the joined line only when the engine took it as the chat's (its first row)", () => {
  const common = { linkId: "chat", text: "👋 Casper joined", timestamp: 1, via: "datalink" as const, sender: "peer" as const };
  const first = toChatMessage({ ...common, id: "peer_join", joinLine: true }, "peer", "mine", true);
  expect(first).toMatchObject({ sender: "system", systemEvent: { type: "join", pubKey: "peer" } });
  // The same words in a later row of theirs: their message, drawn as one.
  const later = toChatMessage({ ...common, id: "peer_later" }, "peer", "mine", true);
  expect(later.sender).toBe("peer");
  expect(later).not.toHaveProperty("systemEvent");
  // A 1.8.1 contact's genuine line without a name, as the engine stored it.
  expect(toChatMessage({ ...common, id: "peer_w", text: "👋 joined", joinLine: true }, "peer", "mine", true).sender).toBe("system");
});

it("carries a received row's place and what its sender's clock said, each as it is", () => {
  const row = { linkId: "chat", id: "peer_1", text: "hello", sender: "peer" as const, timestamp: 1_000, sentAt: 121_000, via: "datalink" as const };
  expect(toChatMessage(row, "peer", "mine", true)).toMatchObject({ timestamp: 1_000, sentAt: 121_000 });
  // Mine, and a row from before the sender's time was kept beside it: no such time.
  expect(toChatMessage({ ...row, id: "me_1", sender: "me", sentAt: undefined }, "peer", "mine", true)).not.toHaveProperty("sentAt");
});

import { expect, it, vi } from "vitest";
import { toChatMessage } from "../src/platform/sync";
vi.mock("../src/platform/engine", () => ({ engine: {} }));
// covers: chat.paired.join-notice, chat.order

it("attributes each join announcement to its actual sender", () => {
  const common = { linkId: "chat", text: "👋 Casper joined", timestamp: 1, via: "datalink" as const };
  const mine = toChatMessage({ ...common, id: "me_join", sender: "me", delivery: "delivered" }, "peer", "mine");
  const theirs = toChatMessage({ ...common, id: "peer_join", sender: "peer" }, "peer", "mine");
  expect(mine.systemEvent).toEqual({ type: "join", pubKey: "mine" });
  expect(theirs.systemEvent).toEqual({ type: "join", pubKey: "peer" });
});

it("carries a received row's place and what its sender's clock said, each as it is", () => {
  const row = { linkId: "chat", id: "peer_1", text: "hello", sender: "peer" as const, timestamp: 1_000, sentAt: 121_000, via: "datalink" as const };
  expect(toChatMessage(row, "peer", "mine", true)).toMatchObject({ timestamp: 1_000, sentAt: 121_000 });
  // Mine, and a row from before the sender's time was kept beside it: no such time.
  expect(toChatMessage({ ...row, id: "me_1", sender: "me", sentAt: undefined }, "peer", "mine", true)).not.toHaveProperty("sentAt");
});

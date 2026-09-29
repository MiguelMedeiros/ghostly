import { expect, it, vi } from "vitest";
import { toChatMessage } from "../src/platform/sync";
vi.mock("../src/platform/engine", () => ({ engine: {} }));
// covers: chat.paired.join-notice

it("attributes each join announcement to its actual sender", () => {
  const common = { linkId: "chat", text: "👋 Casper joined", timestamp: 1, via: "datalink" as const };
  const mine = toChatMessage({ ...common, id: "me_join", sender: "me", delivery: "delivered" }, "peer", "mine");
  const theirs = toChatMessage({ ...common, id: "peer_join", sender: "peer" }, "peer", "mine");
  expect(mine.systemEvent).toEqual({ type: "join", pubKey: "mine" });
  expect(theirs.systemEvent).toEqual({ type: "join", pubKey: "peer" });
});

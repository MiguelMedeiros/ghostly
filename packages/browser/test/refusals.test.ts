import { describe, expect, it, vi } from "vitest";
import { paymentRefusal, refusedRow } from "../src/shared/refusals";
import { toChatMessage } from "../src/platform/sync";
vi.mock("../src/platform/engine", () => ({ engine: {} }));
// covers: payments.chat.refused

/* agents#2252: the line a refused payment leaves in the chat is the app's own, said from its values. */
describe("a refused payment's line", () => {
  const reason = "Ecash from 127.0.0.1 is not accepted";

  it("is stored with its values and their English, test sats on Testnet", () => {
    expect(refusedRow({ amount: 1000, network: "testnet", reason })).toEqual({
      text: `Could not receive 1,000 test sats: ${reason}`,
      notice: { type: "paymentRefused", amount: 1000, network: "testnet", reason },
    });
    expect(refusedRow({ amount: 21, network: "mainnet", reason }).text).toBe(`Could not receive 21 sats: ${reason}`);
    expect(refusedRow({ reason: "Unsupported amount" }).text).toBe("Could not receive a payment: Unsupported amount");
    // Fedimint's English stays what it was, for the CLI and older apps; the values carry the amount.
    expect(refusedRow({ amount: 5, network: "testnet", method: "fedimint", reason: "These notes were already redeemed" })).toEqual({
      text: "Could not receive Fedimint ecash: These notes were already redeemed",
      notice: { type: "paymentRefused", amount: 5, network: "testnet", method: "fedimint", reason: "These notes were already redeemed" },
    });
  });

  it("reads the stored values back, leaving out what is not valid", () => {
    const row = (notice: unknown) => ({ id: "peer_7_refused", text: "whatever", notice });
    expect(paymentRefusal(row({ type: "paymentRefused", amount: 21, network: "testnet", reason }))).toEqual({ type: "paymentRefused", amount: 21, network: "testnet", reason });
    expect(paymentRefusal(row({ type: "paymentRefused", amount: -1, network: "moon", method: "x", reason }))).toEqual({ type: "paymentRefused", reason });
    expect(paymentRefusal(row({ type: "paymentRefused", amount: 1.5, reason: "x".repeat(2_000) }))?.reason).toHaveLength(500);
  });

  it("reads a line older versions stored in English, in whatever locale they wrote the amount", () => {
    expect(paymentRefusal({ id: "peer_7_refused", text: `Could not receive 1.000 sats: ${reason}` })).toEqual({ type: "paymentRefused", amount: 1000, reason });
    expect(paymentRefusal({ id: `peer_spent_${"a".repeat(32)}`, text: "Could not receive 1 000 sats: This ecash was already spent somewhere else" }))
      .toEqual({ type: "paymentRefused", amount: 1000, reason: "This ecash was already spent somewhere else" });
    expect(paymentRefusal({ id: "peer_7_refused", text: "Could not receive a payment: Unsupported amount" })).toEqual({ type: "paymentRefused", reason: "Unsupported amount" });
    expect(paymentRefusal({ id: "peer_7_refused", text: "Could not receive Fedimint ecash: Fedimint is off in this chat" }))
      .toEqual({ type: "paymentRefused", method: "fedimint", reason: "Fedimint is off in this chat" });
  });

  it("is never a contact's message, whatever it says", () => {
    expect(paymentRefusal({ id: "peer_7", text: `Could not receive 21 sats: ${reason}` })).toBeUndefined();
    expect(paymentRefusal({ id: "peer_7", text: "x", notice: { type: "paymentRefused", reason } })).toBeUndefined();
    expect(paymentRefusal({ id: "me_7_refused", text: `Could not receive 21 sats: ${reason}` })).toBeUndefined();
    expect(paymentRefusal({ id: "peer_7_refused", text: "hello" })).toBeUndefined();
  });

  it("reaches the chat as the app's line, not the contact's", () => {
    const stored = { linkId: "chat", id: "peer_7_refused", sender: "peer" as const, timestamp: 7, via: "datalink" as const, ...refusedRow({ amount: 21, network: "testnet", reason }) };
    expect(toChatMessage(stored, "peer", "mine", true)).toMatchObject({ sender: "system", notice: { type: "paymentRefused", amount: 21, network: "testnet", reason } });
    const older = { ...stored, notice: undefined, text: `Could not receive 21 sats: ${reason}` };
    expect(toChatMessage(older, "peer", "mine", true)).toMatchObject({ sender: "system", notice: { type: "paymentRefused", amount: 21, reason } });
    const theirs = toChatMessage({ ...older, id: "peer_9" }, "peer", "mine", true);
    expect(theirs.sender).toBe("peer");
    expect(theirs).not.toHaveProperty("notice");
  });
});

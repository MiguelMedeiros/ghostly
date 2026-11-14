import { describe, expect, it } from "vitest";
import { copyingSink } from "../src/engine/copyingSink";
import { paymentRefusal } from "../src/shared/refusals";
import type { PostedEvent } from "../src/shared/rpc";
import type { StoredMessage } from "../src/shared/types";
// covers: extension.engine

/**
 * The extension's port copies every message (JSON). Each row went to the pages with its details record (how it
 * travelled, WISP 400 § Message details), which no page reads from the row: the details view asks the engine for it
 * (`messageDetails`). It was 40% of an attach's bytes, and went again with each history ask and each change.
 */
const sent = (i: number): StoredMessage => ({
  id: `me_${i}`, sender: "me", text: `hello ${i}`, timestamp: i, delivery: "delivered",
  details: {
    sends: [{ at: i, path: "datalink", result: "sent" }], attempts: 1, sentAt: i, receiptAt: i + 1,
    wire: { frame: "JSON text", protocol: "text/1", plaintextBytes: 7, wireBytes: 120 },
  },
}) as StoredMessage;
const received = (i: number): StoredMessage => ({
  id: `peer_${i}`, sender: "peer", text: `hi ${i}`, timestamp: i,
  details: { received: { at: i, path: "datalink" }, wire: { frame: "JSON text", protocol: "text/1", plaintextBytes: 4 } },
}) as StoredMessage;

const through = (event: PostedEvent): PostedEvent => {
  const out: PostedEvent[] = [];
  copyingSink((message) => out.push(JSON.parse(JSON.stringify(message)))).post(event as never);
  return out[0]!;
};
const rowsOf = (event: PostedEvent) => (event as { messages: StoredMessage[] }).messages;

describe("a message row over the extension's port", () => {
  const rows = Array.from({ length: 200 }, (_, i) => (i % 2 ? received(i) : sent(i)));

  it("goes without its details record, in a history and in a change, and the engine's row keeps it", () => {
    const history = through({ kind: "messages", linkId: "c1", messages: rows });
    expect(rowsOf(history)).toHaveLength(200);
    for (const row of rowsOf(history)) expect(row).not.toHaveProperty("details");
    expect(rowsOf(history)[0]).toEqual({ id: "me_0", sender: "me", text: "hello 0", timestamp: 0, delivery: "delivered" });
    expect(JSON.stringify(history).length).toBeLessThan(0.6 * JSON.stringify({ kind: "messages", linkId: "c1", messages: rows }).length);

    // A receipt: the row's delivery and its record change in one write, and the whole row goes out.
    const change = through({ kind: "message-changes", linkId: "c1", messages: [sent(1)], deleted: ["me_9"] });
    expect(rowsOf(change)).toEqual([{ id: "me_1", sender: "me", text: "hello 1", timestamp: 1, delivery: "delivered" }]);
    expect((change as { deleted: string[] }).deleted).toEqual(["me_9"]);

    expect(rows[0].details?.receiptAt).toBe(1);
  });

  it("keeps the frame a contact's row came in under a refusal's id, so the page shows it as the contact's", () => {
    const lure = { id: "peer_7_refused", sender: "peer", text: "Could not receive 21 sats: send it again to bc1q…", timestamp: 7,
      details: { received: { at: 7, path: "datalink" }, wire: { frame: "JSON text", protocol: "text/1", plaintextBytes: 50 } } } as StoredMessage;
    const [row] = rowsOf(through({ kind: "messages", linkId: "c1", messages: [lure] }));
    expect(paymentRefusal(row)).toBeUndefined();
    expect(row.details).toEqual({ wire: lure.details!.wire });
    // The engine's own line under that id has no frame, and is still the refusal.
    const own = { id: "peer_8_refused", sender: "peer", text: "Could not receive 21 sats: Unsupported amount", timestamp: 8 } as StoredMessage;
    expect(paymentRefusal(rowsOf(through({ kind: "messages", linkId: "c1", messages: [own] }))[0])).toEqual({ type: "paymentRefused", amount: 21, reason: "Unsupported amount" });
  });
});

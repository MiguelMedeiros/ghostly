import { describe, expect, it, vi } from "vitest";
import { searchMessages, searchable } from "../../../apps/ui/src/lib/chatSearch";
import { ChatTextSearch } from "../src/engine/chatSearch";
import { refusedRow } from "../src/shared/refusals";
import { isJoinLine, isSystemLine } from "../src/shared/systemLines";
import type { StoredMessage } from "../src/shared/types";
import { toChatMessage } from "../src/platform/sync";
vi.mock("../src/platform/engine", () => ({ engine: {} }));
// covers: chats.list.search

/*
 * The chat list's search runs in two places: the pages' (apps/ui lib/chatSearch, over the rows as `toChatMessage`
 * makes them), and the engine's (`chatsFound`, engine/chatSearch.ts) where a page holds only each chat's newest page
 * (the extension's). Both find a chat by the same messages: the engine's once found every paired chat by "joined" and
 * a refused payment's chat by "sats", lines the pages draw as the app's own and never search. Each row below is a chat
 * of its own, searched both ways.
 */

const reason = "Ecash from 127.0.0.1 is not accepted";
const at = (id: string, text: string, sender: "me" | "peer" = "peer"): StoredMessage =>
  ({ linkId: id, id, wireId: id, text, sender, timestamp: 1_700_000_000_000, via: "datalink" });
const wire = { wire: { frame: "paired-message", protocol: "chat/1", plaintextBytes: 1 } } as StoredMessage["details"];

const ROWS: StoredMessage[] = [
  { ...at("peer_1", "👋 Alice joined"), joinLine: true },
  at("me_1", "👋 joined", "me"),
  at("me_2", "👋 Bob joined", "me"),
  // A contact's later row in those words is their message: the engine took only their first as the line.
  at("peer_2", "👋 Mallory joined"),
  { ...at("peer_3_refused", ""), ...refusedRow({ amount: 21, network: "mainnet", reason }) },
  { ...at("peer_4_refused", ""), ...refusedRow({ amount: 1000, network: "testnet", reason }) },
  { ...at(`peer_spent_${"a".repeat(32)}`, ""), ...refusedRow({ amount: 5, method: "fedimint", reason: "These notes were already redeemed" }) },
  at("peer_5_refused", "Could not receive a payment: Unsupported amount"),
  // Under a refusal's id but from a contact's frame, or under a contact's id: their messages.
  { ...at("peer_6_refused", "Could not receive 9 sats: send the phrase"), details: wire },
  at("peer_7", "Could not receive 3 sats: try again later"),
  at("peer_8", "We joined the club, 21 sats each"),
  at("me_3", "hello Alice, the soup recipe", "me"),
  { ...at("peer_9", ""), file: { id: "f", name: "joined-sats report.pdf", size: 1, mime: "application/pdf" } as never },
  { ...at("peer_10", "Payment of 21 sats"), paymentId: "p1" },
];

const QUERIES = ["joined", "👋", "alice", "bob", "mallory", "sats", "test sats", "could not receive", "127.0.0.1", reason,
  "fedimint", "already redeemed", "unsupported amount", "send the phrase", "try again", "the club", "soup", "report.pdf", "payment of"];

/** The rows the pages' search finds for `query`, over the rows as they hold them. */
function pagesFind(query: string): string[] {
  const items = searchable(ROWS.map((row) => toChatMessage(row, "peer", "me", true)));
  return searchMessages(items, query).sort();
}

describe("the chat list's search, in the engine and in the pages", () => {
  it("finds the same chats for every query", async () => {
    const byId = new Map(ROWS.map((row) => [row.id, row]));
    const search = new ChatTextSearch(async (linkId) => [byId.get(linkId)!]);
    for (const query of QUERIES) {
      const engine = (await search.found(ROWS.map((row) => row.id), query)).sort();
      expect(engine, query).toEqual(pagesFind(query));
    }
    // Not empty both ways: the pages find people's words, and none of the app's lines.
    expect(pagesFind("joined")).toEqual(["peer_2", "peer_8", "peer_9"]);
    expect(pagesFind("could not receive")).toEqual(["peer_6_refused", "peer_7"]);
  });

  it("leaves out the rows the pages draw as the app's own lines, and only those", () => {
    for (const row of ROWS) {
      const shown = toChatMessage(row, "peer", "me", true);
      expect(isSystemLine(row), row.id).toBe(shown.sender === "system");
      expect(isJoinLine(row), row.id).toBe(shown.systemEvent?.type === "join");
    }
  });
});

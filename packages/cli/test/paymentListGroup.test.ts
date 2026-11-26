import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { EngineState, LinkView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { EventHub, type GhostlyEvent } from "../src/events";
import { openPersistentIndexedDb } from "../src/runtime/storage";
// covers: headless.payments

/**
 * `payment list` names a group's payment's group whichever link it went over, as the `payment.created` event does: a
 * bot that catches up from the list after a restart places the same payments the stream placed. Before, only a request
 * to the whole group carried `group`; a member paying it over their edge, a member's request that came to me and a
 * community payment on `cpay:<group>:<key>` were listed with only `chat`, an id `chat show` does not know.
 */
let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ghostly-payment-list-group-"));
  await openPersistentIndexedDb(join(dir, "db"));
});

const mesh = "g1", community = "Cmty0123456789abcdefgh", bo = "b".repeat(52);
const groups = [
  { id: mesh, name: "Crew", members: [{ key: "mekey", me: true }, { key: "anakey", edge: { linkId: "edge-ana", state: "open" } }] },
  { id: community, name: "Square", members: [] },
];
const c1 = { id: "c1", peerPubKeyZ32: "peerc1", label: "alice", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", textDelivery: "dht", pairing: { status: "ready" } } as unknown as LinkView;
const pay = (id: string, linkId: string, kind: string, direction: string, createdAt: number, fields: Record<string, unknown> = {}) =>
  ({ id, linkId, kind, direction, amount: 21, unit: "sat", state: "pending", createdAt, ...fields });
const payments = {
  // Mine, to the whole group; Ana paying it over her edge; Ana's request to the group as it came to me; Bo paying in
  // the community; a plain chat's.
  r1: pay("r1", `group:${mesh}`, "request", "out", 5, { group: mesh }),
  p1: pay("p1", "edge-ana", "payment", "in", 4, { requestId: "r1", state: "settled" }),
  r2: pay("r2", "edge-ana", "request", "in", 3),
  p2: pay("p2", `cpay:${community}:${bo}`, "payment", "in", 2, { state: "settled" }),
  p3: pay("p3", "c1", "payment", "in", 1, { state: "settled" }),
};
const engineState = () => ({ links: [c1], groups, settings: {}, transport: {}, payments }) as unknown as EngineState;

function fake() {
  const node = { getState: engineState, chatView: (id: string) => (id === "c1" ? c1 : undefined) };
  return { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {} }, mode: "daemon", version: "t" } as unknown as ApiContext;
}
type Row = { id: string; chat: string; group?: string };
const list = async (params: Record<string, unknown> = {}) => (await callApi(fake(), "payment.list", params) as { payments: Row[] }).payments;

describe("payment list names a group's payment's group", () => {
  it("whichever link it went over: a member's edge or a community's cpay link; chat stays the link", async () => {
    expect((await list()).map((p) => [p.id, p.group ?? null, p.chat])).toEqual([
      ["r1", mesh, `group:${mesh}`],
      ["p1", mesh, "edge-ana"],
      ["r2", mesh, "edge-ana"],
      ["p2", community, `cpay:${community}:${bo}`],
      ["p3", null, "c1"],
    ]);
  });

  it("gives a plain chat's payment no group at all", async () => {
    const [p3] = await list({ chat: "c1" });
    expect(p3.id).toBe("p3");
    expect(p3).not.toHaveProperty("group");
  });

  it("gives each payment as its payment.created event does", async () => {
    const h = new EventHub(join(dir, "agree.jsonl"), () => 1000, "agree.jsonl");
    await h.open();
    const events: GhostlyEvent[] = [];
    h.onEvent((e) => events.push(e));
    h.baseline({ ...engineState(), payments: {} } as unknown as EngineState, new Map());
    h.sink.post({ kind: "state", state: engineState() });
    const created = new Map(events.filter((e) => e.type === "payment.created").map((e) => [(e.payment as Row).id, e]));
    const rows = await list();
    expect(created.size).toBe(rows.length);
    for (const row of rows) {
      expect(created.get(row.id)?.payment, row.id).toEqual(row);
      expect(created.get(row.id)?.chat, row.id).toBe(row.chat);
    }
  });

  it("--chat takes a chat only: neither a member's edge nor a group is one", async () => {
    await expect(list({ chat: "edge-ana" })).rejects.toMatchObject({ code: "not_found", message: expect.stringMatching(/^No chat "edge-ana"/) });
    await expect(list({ chat: "Crew" })).rejects.toMatchObject({ code: "not_found", details: { group: mesh } });
  });
});

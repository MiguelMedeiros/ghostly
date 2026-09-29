import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineServer } from "../src/engine/server";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import { applyMessageChanges } from "../src/shared/messageChanges";
import type { EngineEvent, RpcResponse } from "../src/shared/rpc";
import type { StoredMessage } from "../src/shared/types";
// covers: groups.leave, groups.forget, groups.community.leave

/**
 * A group's history goes with the group when I leave or forget it (`db.deleteGroup`), and the pages' copy goes too.
 * A page keeps each history it was sent and hears only what changes in it (engine/server.ts, platform/engine.ts): a
 * community left and joined again by its link showed its old history again, under what came after, until a reload
 * (bug hunt r5b, 2026-09-29).
 */
const fixture = { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) };
const servers: EngineServer[] = [];

/** A page's copy of the histories, kept as platform/engine.ts keeps it. */
function page() {
  const messages = new Map<string, StoredMessage[]>();
  return {
    messages,
    post(event: EngineEvent | RpcResponse) {
      if (event.kind === "messages") messages.set(event.linkId, event.messages);
      else if (event.kind === "message-changes") {
        const history = messages.get(event.linkId);
        if (history) messages.set(event.linkId, applyMessageChanges(history, event));
      }
    },
  };
}
const texts = (list: StoredMessage[] | undefined) => (list ?? []).filter((m) => !m.event).map((m) => m.text);

async function started() {
  const server = new EngineServer({ automaticWallets: false, transport: fixture });
  servers.push(server);
  await server.ready;
  const client = page();
  server.attach(client);
  return { server, node: server.node, client };
}
const said = (groupId: string, id: string, text: string): StoredMessage =>
  ({ linkId: `group:${groupId}`, id, text, sender: "peer", member: "m", timestamp: Date.now(), via: "datalink" });

beforeEach(async () => {
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await transact([STORES.links, STORES.messages, STORES.groups], (s) => { for (const n of [STORES.links, STORES.messages, STORES.groups]) s[n].clear(); });
});
afterEach(async () => { for (const server of servers.splice(0)) await server.node.shutdown(); });

describe("a group left or forgotten", () => {
  it.each([
    ["a community, left", "community", "leaveGroup"],
    ["a community, forgotten", "community", "forgetGroup"],
    ["a private group, forgotten", "mesh", "forgetGroup"],
  ] as const)("%s: the page's copy of its history goes too, and what comes after a new join shows alone", async (_, profile, how) => {
    const { node, client } = await started();
    const { groupId } = await node.createGroup({ name: "Plaza", profile });
    const link = `group:${groupId}`;
    await node["storeMessage"](said(groupId, "old", "before I left"));
    await expect.poll(() => texts(client.messages.get(link))).toEqual(["before I left"]);

    await node[how]({ groupId });
    expect(await db.getMessages(link)).toEqual([]);
    await expect.poll(() => texts(client.messages.get(link))).toEqual([]);

    // In again (a join by the link keeps the group's id): only what comes now.
    await node["storeMessage"](said(groupId, "new", "after I came back"));
    await expect.poll(() => texts(client.messages.get(link))).toEqual(["after I came back"]);
  });
});

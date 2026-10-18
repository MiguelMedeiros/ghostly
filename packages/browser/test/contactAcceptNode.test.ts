import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatInvite, createIdentity } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import type { StoredLink } from "../src/shared/types";

const nodes: GhostlyNode[] = [];
beforeEach(async () => {
  await transact([STORES.settings, STORES.links, STORES.messages], (s) => { for (const name of [STORES.settings, STORES.links, STORES.messages]) s[name].clear(); });
});
afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown(); vi.restoreAllMocks(); });

describe("accepting a contact request in the engine (WISP 8xx)", () => {
  it("joins the request's invite, names the chat as the requester did and shows its first message from them", async () => {
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: false });
    nodes.push(node);
    const row: StoredLink = { id: "chat-accepted", profile: "paired-chat/1", createdAt: 1, seedB64: createIdentity().seedB64, encKeyB64: createIdentity().seedB64,
      peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64 };
    await db.putLink(row);
    node["links"].set(row.id, { stored: row, myPubKeyZ32: "me", link: null as never, status: "online", dataLink: "open",
      presence: { online: true, lastPacketAt: 0, services: null }, lastMessageAt: 0, peerAck: 0, lastSyncAt: 0,
      poll: { polling: false, nextAt: 0, interval: 0 }, files: { receivedBytes: 0, wireIds: new Set(), incoming: new Map() } } as never);
    const join = vi.spyOn(node, "joinLink").mockResolvedValue({ linkId: row.id });
    const invite = createChatInvite().inviteCode;
    const asker = createIdentity().pubKeyZ32;
    const linkId = await node["contactLinks"]["host"].accept({ key: asker, invite, name: "Kevin", text: "Hi, from your site", issued: 1_000, expires: 2_000, receivedAt: 1_500 });
    expect(linkId).toBe(row.id);
    expect(join).toHaveBeenCalledWith({ inviteCode: invite });
    expect(node.getState().links.find((l) => l.id === row.id)?.label).toBe("Kevin");
    const messages = await db.getMessages(row.id);
    expect(messages.map((m) => ({ text: m.text, sender: m.sender }))).toEqual([{ text: "Hi, from your site", sender: "peer" }]);
  });

  it("refuses a request whose invite is a chat this profile already has, and touches nothing", async () => {
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: false });
    nodes.push(node);
    const { invite, inviteCode } = createChatInvite();
    const row: StoredLink = { id: "chat-known", profile: "paired-chat/1", createdAt: 1, seedB64: invite.seedB64, encKeyB64: invite.encKeyB64,
      peerPubKeyZ32: invite.peerPubKeyZ32, participationSeed: createIdentity().seedB64, label: "Alice" };
    await db.putLink(row);
    node["links"].set(row.id, { stored: row, myPubKeyZ32: "me", link: null as never, status: "online", dataLink: "open",
      presence: { online: true, lastPacketAt: 0, services: null }, lastMessageAt: 0, peerAck: 0, lastSyncAt: 0,
      poll: { polling: false, nextAt: 0, interval: 0 }, files: { receivedBytes: 0, wireIds: new Set(), incoming: new Map() } } as never);
    const join = vi.spyOn(node, "joinLink");
    expect(node["contactLinks"]["host"].ownInvite(inviteCode)).toBe(true);
    await expect(node["contactLinks"]["host"].accept({ key: createIdentity().pubKeyZ32, invite: inviteCode, name: "Alice", text: "I'm Alice, trust me", issued: 1, expires: 2, receivedAt: 1 }))
      .rejects.toThrow("a chat you already have");
    expect(join).not.toHaveBeenCalled();
    expect(await db.getMessages(row.id)).toEqual([]);
  });

  it("deleting the chat a request made takes the request back", async () => {
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: false });
    nodes.push(node);
    const row: StoredLink = { id: "chat-asked", profile: "paired-chat/1", createdAt: 1, seedB64: createIdentity().seedB64, encKeyB64: createIdentity().seedB64,
      peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64 };
    await db.putLink(row);
    node["links"].set(row.id, { stored: row, myPubKeyZ32: "me", link: null as never, status: "online", dataLink: "open",
      presence: { online: true, lastPacketAt: 0, services: null }, lastMessageAt: 0, peerAck: 0, lastSyncAt: 0,
      poll: { polling: false, nextAt: 0, interval: 0 }, files: { receivedBytes: 0, wireIds: new Set(), incoming: new Map() } } as never);
    const asker = createIdentity();
    node.contactAsks["asks"] = [{ link: createIdentity().pubKeyZ32, key: asker.pubKeyZ32, seed: { sealed: {} as never, deviceKey: "" }, chatId: row.id,
      invite: createChatInvite().inviteCode, name: "Kevin", text: "hi", issued: Date.now(), expires: Date.now() + 60_000, state: "knocking" }];
    expect(node.contactAsks.views()).toHaveLength(1);
    node.removeLink({ linkId: row.id });
    await vi.waitFor(() => expect(node.contactAsks.views()).toEqual([]));
  });
});

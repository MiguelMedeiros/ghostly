import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contactAskerFrame, contactAskerHolds, createChatInvite, createContactLink, createIdentity } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { sealSecret } from "../src/engine/dataKey";
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
    // The requester chose that name: it is the contact's own, never a name given on this side.
    const view = node.getState().links.find((l) => l.id === row.id);
    expect({ label: view?.label, peerNick: view?.peerNick }).toEqual({ label: undefined, peerNick: "Kevin" });
    const stored = (await db.getLinks()).find((l) => l.id === row.id);
    expect({ label: stored?.label, peerNick: stored?.peerNick }).toEqual({ label: undefined, peerNick: "Kevin" });
    const messages = await db.getMessages(row.id);
    expect(messages.map((m) => ({ text: m.text, sender: m.sender }))).toEqual([{ text: "Hi, from your site", sender: "peer" }]);
  });

  it("keeps a request's name as the contact's own even when it looks like a group ref, cleaned as a label is", async () => {
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: false });
    nodes.push(node);
    const row: StoredLink = { id: "chat-named-group", profile: "paired-chat/1", createdAt: 1, seedB64: createIdentity().seedB64, encKeyB64: createIdentity().seedB64,
      peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64 };
    await db.putLink(row);
    node["links"].set(row.id, { stored: row, myPubKeyZ32: "me", link: null as never, status: "online", dataLink: "open",
      presence: { online: true, lastPacketAt: 0, services: null }, lastMessageAt: 0, peerAck: 0, lastSyncAt: 0,
      poll: { polling: false, nextAt: 0, interval: 0 }, files: { receivedBytes: 0, wireIds: new Set(), incoming: new Map() } } as never);
    vi.spyOn(node, "joinLink").mockResolvedValue({ linkId: row.id });
    await node["contactLinks"]["host"].accept({ key: createIdentity().pubKeyZ32, invite: createChatInvite().inviteCode, name: "  group:Crew​  ", text: "hi", issued: 1_000, expires: 2_000, receivedAt: 1_500 });
    const view = node.getState().links.find((l) => l.id === row.id);
    expect({ label: view?.label, peerNick: view?.peerNick }).toEqual({ label: undefined, peerNick: "group:Crew" });
  });

  it("shows a request's text as not confirmed until the asker's app proves it in the chat, and only the asker key's proof for this chat does", async () => {
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: false });
    nodes.push(node);
    // Someone else's unused invite, put in a request: the chat the owner joins is its maker's, who never asked.
    const inviter = createIdentity(), mine = createIdentity();
    const row: StoredLink = { id: "chat-from-request", profile: "paired-chat/1", createdAt: 1, seedB64: createIdentity().seedB64, encKeyB64: createIdentity().seedB64,
      peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: mine.seedB64, pairedPeerKey: inviter.pubKeyZ32 };
    await db.putLink(row);
    node["links"].set(row.id, { stored: row, myPubKeyZ32: "me", link: null as never, status: "online", dataLink: "open",
      presence: { online: true, lastPacketAt: 0, services: null }, lastMessageAt: 0, peerAck: 0, lastSyncAt: 0,
      poll: { polling: false, nextAt: 0, interval: 0 }, files: { receivedBytes: 0, wireIds: new Set(), incoming: new Map() } } as never);
    vi.spyOn(node, "joinLink").mockResolvedValue({ linkId: row.id });
    const asker = createIdentity(), link = createContactLink().linkKeyZ32;
    await node["contactLinks"]["host"].accept({ key: asker.pubKeyZ32, link, invite: createChatInvite().inviteCode, name: "Kevin", text: "Hi, it's me", issued: 1_000, expires: 2_000, receivedAt: 1_500 });
    const shown = async () => (await db.getMessages(row.id)).map((m) => ({ text: m.text, sender: m.sender, unconfirmed: !!m.unconfirmed }));
    expect(await shown()).toEqual([{ text: "Hi, it's me", sender: "peer", unconfirmed: true }]);

    const keys = { mine: mine.pubKeyZ32, peer: inviter.pubKeyZ32 };
    const heard = (frame: unknown) => node["contactAskerHeard"](row.id, frame, keys);
    // The invite's maker cannot sign for the asker key: its own key, another chat's proof, another link's, prove nothing.
    const other = createIdentity();
    await heard({ ...contactAskerFrame(other.seedB64, link, { inviter: inviter.pubKeyZ32, joiner: mine.pubKeyZ32 }), k: asker.pubKeyZ32 });
    await heard(contactAskerFrame(other.seedB64, link, { inviter: inviter.pubKeyZ32, joiner: mine.pubKeyZ32 }));
    await heard(contactAskerFrame(asker.seedB64, link, { inviter: inviter.pubKeyZ32, joiner: createIdentity().pubKeyZ32 }));
    await heard(contactAskerFrame(asker.seedB64, createContactLink().linkKeyZ32, { inviter: inviter.pubKeyZ32, joiner: mine.pubKeyZ32 }));
    expect(await shown()).toEqual([{ text: "Hi, it's me", sender: "peer", unconfirmed: true }]);

    // The real asker, in this chat: confirmed, and nothing is waited for any more.
    await heard(contactAskerFrame(asker.seedB64, link, { inviter: inviter.pubKeyZ32, joiner: mine.pubKeyZ32 }));
    expect(await shown()).toEqual([{ text: "Hi, it's me", sender: "peer", unconfirmed: false }]);
    expect((await db.getLinks()).find((l) => l.id === row.id)?.contactAsker).toBeUndefined();
  });

  it("the asker's app has a proof for the chat its request started, and none for another", async () => {
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: false });
    nodes.push(node);
    const asker = createIdentity(), link = createContactLink().linkKeyZ32;
    const seed = await sealSecret(asker.seedB64, { store: STORES.settings, key: link, field: "contactAsk.seed" });
    node.contactAsks["asks"] = [{ link, key: asker.pubKeyZ32, seed, chatId: "chat-asked", invite: createChatInvite().inviteCode, name: "Kevin", text: "hi",
      issued: Date.now(), expires: Date.now() + 60_000, state: "seen" }];
    const chat = { inviter: createIdentity().pubKeyZ32, joiner: createIdentity().pubKeyZ32 };
    const frame = await node.contactAsks.proof("chat-asked", chat);
    expect(contactAskerHolds(frame, { link, key: asker.pubKeyZ32 }, chat)).toBe(true);
    expect(await node.contactAsks.proof("another-chat", chat)).toBeUndefined();
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

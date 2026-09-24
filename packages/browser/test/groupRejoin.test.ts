import { describe, expect, it } from "vitest";
import { createIdentity } from "@ghostly/core";
import { Groups, type GroupStore, type GroupsHost } from "../src/engine/groups";
import type { StoredGroup } from "../src/shared/types";
// covers: groups.invite, groups.remove-member

/**
 * `StoredGroup.contacts` keeps the chat a member joined through after they are removed or leave (the
 * removal notice goes over it). Such a chat is no longer a member's: the invite picker offers it again,
 * and inviting over it works.
 */
describe("a contact who is no longer a member", () => {
  it("is not listed as a member's chat, and can be invited again", async () => {
    const groups = new Map<string, StoredGroup>();
    const store: GroupStore = { getGroups: async () => [...groups.values()], putGroup: async g => { groups.set(g.id, structuredClone(g)); }, deleteGroup: async id => { groups.delete(id); }, getMessages: async () => [] };
    const host: GroupsHost = {
      sendOnLink: () => {}, linkReady: () => true, contactName: () => "Bob", edges: () => new Map(), openEdge: async () => "edge", closeEdge: async () => {},
      edgeNick: () => undefined, openEntry: async () => "entry", entries: () => new Map(), publish: async () => {}, resolve: async () => null, storeMessage: async () => {}, emit: () => {},
    };
    const alice = new Groups(host, store);
    const groupId = await alice.create("Ghosts");
    await alice.invite(groupId, "chat-ab");
    const bob = createIdentity().pubKeyZ32;
    await alice.handleContactFrame("chat-ab", { t: "group-accept", g: groupId, key: bob });
    expect(alice.views()[0].members).toHaveLength(2);
    await alice.remove(groupId, bob);
    expect(alice.views()[0].members).toHaveLength(1);
    expect(alice.views()[0].memberLinks).toEqual({});
    await expect(alice.invite(groupId, "chat-ab")).resolves.toBeUndefined();
  });
});

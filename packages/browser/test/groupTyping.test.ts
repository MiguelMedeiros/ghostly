import { describe, expect, it } from "vitest";
import { createIdentity, GROUP_TYPING_FRAME, typingFrame, sealGroupTyping } from "@ghostly/core";
import { CommunityWorld } from "./communityWorld";
// covers: groups.typing

/**
 * Typing in a private group (WISP 902 · Group Mesh § Typing) on headless peers running the real group engine: the word
 * goes sealed on the edges, each member sees who is typing, a message ends it, and nobody outside the group is heard.
 */
describe("group typing on headless peers", { timeout: 120_000 }, () => {
  it("a private group: members see who types and what they do; a message ends it; a stranger's frame says nothing", async () => {
    const world = new CommunityWorld();
    const alice = world.add("alice"), bob = world.add("bob"), carol = world.add("carol");
    const id = await alice.groups.create("Mesh crew", "mesh");
    const link = await alice.groups.enableLink(id);
    for (const m of [bob, carol]) await m.groups.joinByLink(link);
    await world.until(() => [bob, carol].every(m => world.member(m, id) && world.view(m, id)!.members.length === 3), 10 * 60_000);
    await world.until(() => [alice, bob, carol].every(m => world.view(m, id)!.members.filter(x => !x.me).every(x => x.online)), 5 * 60_000);
    const key = (p: typeof alice) => world.view(p, id)!.myKey!;
    const typing = (p: typeof alice) => world.view(p, id)!.typing;

    // What goes on the wire is sealed: the kind is not in the clear.
    const wire: Record<string, unknown>[] = [];
    world.drop = (_from, _to, frame) => { if (frame.t === GROUP_TYPING_FRAME) wire.push(frame); return false; };
    alice.groups.setTyping(id, true, { kind: "recording" });
    await world.settle();
    expect(wire.length).toBe(2);
    expect(JSON.stringify(wire)).not.toContain("recording");
    for (const m of [bob, carol]) expect(typing(m)).toEqual([{ key: key(alice), kind: "recording" }]);
    expect(typing(alice)).toBeUndefined();

    // Two at once, in the order they started, with a bot's status cleaned of its link.
    bob.groups.setTyping(id, true, { kind: "thinking", status: "Reading https://x.example" });
    await world.settle();
    expect(typing(carol)).toEqual([{ key: key(alice), kind: "recording" }, { key: key(bob), kind: "thinking" }]);

    // Alice's message ends her word, on her side (a stop) and on theirs (the message).
    await alice.groups.send(id, "hi");
    await world.settle();
    expect(typing(carol)).toEqual([{ key: key(bob), kind: "thinking" }]);
    bob.groups.setTyping(id, false);
    await world.settle();
    expect(typing(carol)).toBeUndefined();

    // Someone outside the group, even with a frame sealed right: never shown.
    const stranger = createIdentity().pubKeyZ32;
    const epoch = world.view(carol, id)!.epoch!;
    const secret = (await carol.store.getGroups()).find(g => g.id === id)!.state!.secrets[epoch];
    await carol.groups.handleEdgeFrame(id, stranger, sealGroupTyping(id, epoch, secret, stranger, typingFrame("start")));
    expect(typing(carol)).toBeUndefined();
  });
});

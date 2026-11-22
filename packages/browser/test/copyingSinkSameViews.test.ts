import { describe, expect, it } from "vitest";
import { copyingSink } from "../src/engine/copyingSink";
import type { PostedState } from "../src/shared/rpc";
import type { EngineState, GroupView, LinkView } from "../src/shared/types";
// covers: extension.engine

/**
 * The extension's port told a view the page has from one that changed by writing each out as JSON, every chat's, edge's
 * and group's, for each state. A file moving sends a state every 250 ms, about its progress alone (the engine keeps
 * every chat's view as it was, the same object): at 2,000 chats that was ~8 ms per open tab per state. A view that is
 * the object the last state had is the one the page was sent, and is not written out again.
 */
const key = (seed: string) => `${seed}${"y".repeat(52 - seed.length)}`;
const picture = (seed: string) => `data:image/jpeg;base64,/9j/${seed.repeat(600 / seed.length)}`;

/**
 * How many times each view was read whole: a field inside it (its `poll`, its first member) counts the reads, which only
 * a JSON copy of the whole view makes (leaving a picture out copies the view's own fields, not what is inside them).
 */
const reads = new Map<string, number>();
const counted = <T extends object>(id: string, inner: T, field: string, value: unknown): T =>
  Object.defineProperty(inner, field, { enumerable: true, get: () => { reads.set(id, (reads.get(id) ?? 0) + 1); return value; } });

const chat = (i: number, more: Partial<LinkView> = {}): LinkView => ({
  id: `chat-${i}`, myPubKeyZ32: key("me"), peerPubKeyZ32: key(`peer${i}`), peerNick: `Contact ${i}`, createdAt: 1_700_000_000_000 + i,
  status: "active", dataLink: "open", peerTyping: false, profile: "paired-chat/1",
  poll: counted(`chat-${i}`, { polling: false }, "interval", 60_000), ...more,
}) as unknown as LinkView;
const group = (g: number): GroupView => ({
  id: `group-${g}`, name: `Group ${g}`, createdAt: 1_700_000_000_000, profile: "mesh", status: "active", epoch: 1,
  members: [counted(`group-${g}`, { key: key(`g${g}m0`), role: "admin" }, "me", true)], invited: [], memberLinks: {}, lastMessageAt: 0, canSend: true,
}) as unknown as GroupView;

const stateOf = (links: LinkView[], groups: GroupView[], edges?: LinkView[], transferred = 0) => ({
  settings: { nick: "me" }, links, groups, ...(edges && { edges }), payments: {}, wallet: { balance: 0 },
  transfers: { f1: { id: "f1", transferred } },
}) as unknown as EngineState;

describe("a state whose views are the ones the last state had, over the extension's port", () => {
  it("does not write those views out again, and still sends one that changed", () => {
    const posted: PostedState[] = [];
    const sink = copyingSink((message) => { if (message.kind === "state") posted.push(JSON.parse(JSON.stringify(message.state))); });
    const links = Array.from({ length: 20 }, (_, i) => chat(i, i === 3 ? { peerAvatar: picture("a3") } : {}));
    const groups = [group(0), group(1)];
    const edges = [chat(100, { group: "group-0", groupPeer: key("g0m1") } as Partial<LinkView>)];
    sink.post({ kind: "state", state: stateOf(links, groups, edges) });
    // The next leaves out what the first sent (chat 3's picture now kept: it goes once more without it).
    sink.post({ kind: "state", state: stateOf(links, groups, edges) });
    expect(posted[1].links.map((v) => v.id)).toEqual(["chat-3"]);

    // A file's progress: every view the same object.
    reads.clear();
    for (let k = 1; k <= 5; k++) sink.post({ kind: "state", state: stateOf(links, groups, edges, k) });
    expect(Object.fromEntries(reads)).toEqual({});
    expect(posted.at(-1)!.links).toEqual([]);
    expect(posted.at(-1)!.groups).toEqual([]);
    expect(posted.at(-1)!.edges).toEqual([]);
    expect((posted.at(-1)!.transfers as Record<string, { transferred: number }>).f1.transferred).toBe(5);

    // One chat's view built again with a change, another built again the same: the first goes, the second stays out.
    const next = links.map((view, i) => (i === 5 ? chat(5, { peerTyping: true }) : i === 6 ? chat(6) : view));
    sink.post({ kind: "state", state: stateOf(next, groups, edges) });
    expect(posted.at(-1)!.links.map((v) => v.id)).toEqual(["chat-5"]);
    expect(posted.at(-1)!.links[0].peerTyping).toBe(true);
    expect(posted.at(-1)!.keptViews?.links).toHaveLength(20);

    // The picture taken away (a new view): it goes without it, and the page is not told to keep the old one.
    const bare = next.map((view, i) => (i === 3 ? chat(3) : view));
    sink.post({ kind: "state", state: stateOf(bare, groups, edges) });
    expect(posted.at(-1)!.links.map((v) => v.id)).toEqual(["chat-3"]);
    expect(posted.at(-1)!.keptPictures?.links ?? []).not.toContain("chat-3");
  });

  it("writes a view out again when it is kept by another sink: each tab's port has its own last state", () => {
    const links = [chat(0), chat(1)];
    const a: PostedState[] = [], b: PostedState[] = [];
    const tabA = copyingSink((m) => { if (m.kind === "state") a.push(m.state); });
    tabA.post({ kind: "state", state: stateOf(links, []) });
    tabA.post({ kind: "state", state: stateOf(links, []) });
    // A tab that opens later gets every view whole.
    const tabB = copyingSink((m) => { if (m.kind === "state") b.push(m.state); });
    tabB.post({ kind: "state", state: stateOf(links, []) });
    expect(a.at(-1)!.links).toEqual([]);
    expect(b.at(-1)!.links.map((v) => v.id)).toEqual(["chat-0", "chat-1"]);
  });
});

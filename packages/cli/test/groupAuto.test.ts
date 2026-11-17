import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GROUP_PROFILE, commitUntaggedHash, confirmationTag, createIdentity, epochKeys, identityFromSeedB64, newEpochSecret, randomBytes, signCommit, toBase64Url, type GroupCommit, type GroupState } from "@ghostly/core";
import { Groups, type GroupStore, type GroupsHost } from "@ghostly/browser/engine/groups";
import type { EngineState, GroupView, LinkView, StoredGroup } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { CallManager, type CallEngine } from "../src/calls/manager";
import { parseArgs } from "../src/args";
import { idSlot, positionals, COMMANDS } from "../src/commands";
import { CliError } from "../src/errors";
import { GroupAutoJoin } from "../src/groupAuto";
import { groupJson } from "../src/views";
import { chatViewOf } from "./support/chatView";
// covers: headless.group-auto, headless.calls

/**
 * `group auto on --from <chat>`: the daemon accepts, by itself, the invitations that came over the chats named, as
 * `group accept` would; any other stays pending. Kept in the profile's groups.json with each chat's contact key.
 */
const OWNER = "owner-key", OTHER = "other-key";
const link = (id: string, peerPubKeyZ32: string, fields: Partial<LinkView> = {}) => ({ id, peerPubKeyZ32, profile: "paired-chat/1", ...fields }) as unknown as LinkView;
const invited = (id: string, linkId: string, fields: Partial<NonNullable<GroupView["invitation"]>> = {}) =>
  ({ id, name: "Crew", profile: "mesh", members: [], isAdmin: false, invitation: { linkId, contact: "", admin: "admin-member-key", members: 2, accepted: false, ...fields } }) as unknown as GroupView;

function world(dir = mkdtempSync(join(tmpdir(), "ghostly-group-auto-")), joins = true) {
  const s = { links: [link("chat-owner", OWNER, { label: "Miguel", peerNick: "Miguel" }), link("chat-other", OTHER, { peerNick: "Mallory" })], groups: [] as GroupView[] };
  const engine = {
    chatView: chatViewOf, getState: () => s as unknown as EngineState,
    acceptGroupInvitation: vi.fn(async ({ groupId }: { groupId: string }) => {
      s.groups = s.groups.map((g) => (g.id === groupId ? { ...g, invitation: { ...g.invitation!, accepted: true } } : g));
    }),
    switchGroup: vi.fn(async (_: { groupId: string; to: string }) => undefined),
  };
  const lines: string[] = [];
  const auto = new GroupAutoJoin({ engine, profileDir: dir, joins, log: (line) => lines.push(line) });
  return { s, engine, auto, lines, dir, state: () => s as unknown as EngineState };
}

describe("group auto", () => {
  it("is off until a chat is named; on with no chat is refused (never from anyone)", () => {
    const w = world();
    expect(w.auto.get()).toEqual({ on: false, from: [] });
    expect(() => w.auto.set({ on: true })).toThrow(CliError);
    expect(() => w.auto.set({ on: true, from: [] })).toThrow(/group auto on --from <chat>/);
    expect(w.auto.get()).toEqual({ on: false, from: [] });
  });

  it("names a chat only by its id, its contact's key or a label given here, never by the name its contact chose", () => {
    const w = world();
    expect(() => w.auto.set({ on: true, from: ["Mallory"] })).toThrow(/only by what its contact chose/);
    expect(w.auto.set({ on: true, from: ["Miguel", "chat-owner"] })).toEqual({ on: true, from: ["chat-owner"] });
  });

  it("reads a chat given many times once, as call auto on --from does", () => {
    // Found in a bug hunt: 50,000 refs from a script were each resolved (8 s of the daemon's thread) before the one chat
    // they named was kept.
    const w = world();
    expect(w.auto.set({ on: true, from: Array(50_000).fill("Miguel") })).toEqual({ on: true, from: ["chat-owner"] });
  });

  it("--from a group says it is a group, not a chat, with its id, as call auto on --from does", () => {
    const w = world();
    w.s.groups = [{ id: "g1crew", name: "Crew", profile: "mesh", members: [], isAdmin: false, status: "active" } as unknown as GroupView];
    const refused = (ref: string) => { try { w.auto.set({ on: true, from: ["chat-owner", ref] }); } catch (error) { expect(error).toBeInstanceOf(CliError); return (error as CliError).toJSON(); } return expect.fail("not refused"); };
    for (const ref of ["Crew", "g1crew", "g1c", "group:g1crew"]) {
      expect(refused(ref)).toEqual({ code: "not_found", message: `${JSON.stringify(ref)} is a group, not a chat (ghostly chat list)`, details: { group: "g1crew" } });
    }
    expect(refused("Nobody")).toEqual({ code: "not_found", message: "No chat \"Nobody\" (ghostly chat list)" });
    expect(w.auto.get()).toEqual({ on: false, from: [] });
    expect(w.auto.set({ on: true, from: ["Miguel"] })).toEqual({ on: true, from: ["chat-owner"] });
  });

  it("accepts an invitation over a granted chat at once and logs the group and the chat; another chat's stays pending", async () => {
    const w = world();
    w.auto.set({ on: true, from: ["Miguel"] });
    w.s.groups = [invited("g-owner", "chat-owner"), invited("g-other", "chat-other")];
    w.auto.check(w.state());
    await vi.waitFor(() => expect(w.engine.acceptGroupInvitation).toHaveBeenCalledTimes(1));
    expect(w.engine.acceptGroupInvitation).toHaveBeenCalledWith({ groupId: "g-owner" });
    expect(w.lines).toEqual(["group auto: accepted the invitation to group g-owner from chat chat-owner"]);
    // Accepted, it waits for the welcome: nothing is said again.
    w.auto.check(w.state());
    await Promise.resolve();
    expect(w.engine.acceptGroupInvitation).toHaveBeenCalledTimes(1);
    expect(w.s.groups.find((g) => g.id === "g-other")?.invitation?.accepted).toBe(false);
  });

  it("leaves a link's join, an invitation taken back and a group already in alone", async () => {
    const w = world();
    w.auto.set({ on: true, from: ["chat-owner"] });
    w.s.groups = [invited("g-link", "chat-owner", { viaLink: true }), invited("g-back", "chat-owner", { takenBack: true }), { ...invited("g-in", "chat-owner"), status: "active" } as GroupView];
    w.auto.check(w.state());
    await Promise.resolve();
    expect(w.engine.acceptGroupInvitation).not.toHaveBeenCalled();
  });

  it("drops a chat whose contact's key changed, and accepts nothing over it", async () => {
    const w = world();
    w.auto.set({ on: true, from: ["chat-owner"] });
    w.s.links = w.s.links.map((l) => (l.id === "chat-owner" ? { ...l, peerPubKeyZ32: "new-key" } : l));
    w.s.groups = [invited("g1", "chat-owner")];
    w.auto.check(w.state());
    await Promise.resolve();
    expect(w.engine.acceptGroupInvitation).not.toHaveBeenCalled();
    expect(w.auto.get()).toEqual({ on: false, from: [] });
    expect(w.lines).toEqual(["group auto: chat chat-owner's contact key changed: its invitations are no longer accepted by themselves"]);
    expect(new GroupAutoJoin({ engine: w.engine, profileDir: w.dir, joins: true }).get()).toEqual({ on: false, from: [] });
  });

  it("is kept in the profile (0600): a daemon that starts accepts what came while it was down", async () => {
    const first = world();
    first.auto.set({ on: true, from: ["Miguel"] });
    const path = join(first.dir, "groups.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ autoJoin: { from: [{ chat: "chat-owner", contact: OWNER }] } });
    // The next daemon on the same profile: the invitation is in the state it starts with.
    const next = world(first.dir);
    expect(next.auto.get()).toEqual({ on: true, from: ["chat-owner"] });
    next.s.groups = [invited("g-while-down", "chat-owner")];
    next.auto.check(next.state());
    await vi.waitFor(() => expect(next.engine.acceptGroupInvitation).toHaveBeenCalledWith({ groupId: "g-while-down" }));
  });

  it("tries again on a later change when the inviter was not connected, and says why only once", async () => {
    const w = world();
    w.auto.set({ on: true, from: ["chat-owner"] });
    let up = false;
    w.engine.acceptGroupInvitation.mockImplementation(async () => { if (!up) throw new Error("The contact who invited you is not connected. Try again when they are."); });
    w.s.groups = [invited("g1", "chat-owner")];
    w.auto.check(w.state());
    await vi.waitFor(() => expect(w.engine.acceptGroupInvitation).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    w.auto.check(w.state());
    await vi.waitFor(() => expect(w.engine.acceptGroupInvitation).toHaveBeenCalledTimes(2));
    up = true;
    w.auto.check(w.state());
    await vi.waitFor(() => expect(w.lines).toHaveLength(2));
    expect(w.lines).toEqual([
      "group auto: the invitation to group g1 from chat chat-owner waits: The contact who invited you is not connected. Try again when they are.",
      "group auto: accepted the invitation to group g1 from chat chat-owner",
    ]);
  });

  it("an invitation over a granted chat finds room when 32 others wait, and is accepted; off, it is dropped as before", async () => {
    // The engine's invitations with the wiring `openHost` makes: the engine asks `autoJoins`, the daemon's check accepts.
    const admin = createIdentity().pubKeyZ32;
    const id = (i: number) => `${String(i).padStart(2, "0")}${"D".repeat(20)}`;
    const engineWith = async (autoJoins?: (chat: string) => boolean) => {
      const stored = new Map<string, StoredGroup>();
      const store: GroupStore = { getGroups: async () => [], putGroup: async (g) => { stored.set(g.id, structuredClone(g)); }, deleteGroup: async (gid) => { stored.delete(gid); }, getMessages: async () => [] };
      const host = { sendOnLink: () => { throw new Error("offline"); }, linkReady: () => false, contactName: () => undefined, edges: () => new Map(), entries: () => new Map(), openEdge: async () => "", closeEdge: async () => {},
        openEntry: async () => "", publish: async () => {}, resolve: async () => null, edgeNick: () => undefined, storeMessage: async () => {}, emit: () => {}, ...(autoJoins ? { autoJoins } : {}) } as unknown as GroupsHost;
      const groups = new Groups(host, store);
      for (let i = 0; i < 32; i++) await groups.handleContactFrame(`chat-${i >> 2}`, { t: "group-invite", g: id(i), name: `g${i}`, admin, e: 0, n: 1 });
      return groups;
    };
    const w = world();
    w.auto.set({ on: true, from: ["Miguel"] });
    const groups = await engineWith((chat) => w.auto.autoJoins(chat));
    await groups.handleContactFrame("chat-owner", { t: "group-invite", g: id(40), name: "Owner's", admin, e: 0, n: 1 });
    w.s.groups = groups.views();
    expect(w.s.groups.map((g) => g.id)).toContain(id(40));
    expect(w.s.groups.map((g) => g.id)).not.toContain(id(0));
    expect(w.s.groups).toHaveLength(32);
    expect(w.auto.autoJoins("chat-owner")).toBe(true);
    expect(w.auto.autoJoins("chat-other")).toBe(false);
    w.auto.check(w.state());
    await vi.waitFor(() => expect(w.engine.acceptGroupInvitation).toHaveBeenCalledWith({ groupId: id(40) }));
    expect(w.engine.acceptGroupInvitation).toHaveBeenCalledTimes(1);

    // Auto-join off (or no `group auto` at all): the 33rd is dropped and the 32 stay, as before.
    w.auto.set({ on: false });
    expect(w.auto.autoJoins("chat-owner")).toBe(false);
    for (const before of [await engineWith((chat) => w.auto.autoJoins(chat)), await engineWith()]) {
      await before.handleContactFrame("chat-owner", { t: "group-invite", g: id(40), name: "Owner's", admin, e: 0, n: 1 });
      expect(before.views().map((g) => g.id).sort()).toEqual(Array.from({ length: 32 }, (_, i) => id(i)));
    }
    // A chat whose contact's key changed is not granted, even before the daemon's check drops it.
    w.auto.set({ on: true, from: ["chat-owner"] });
    w.s.links = w.s.links.map((l) => (l.id === "chat-owner" ? { ...l, peerPubKeyZ32: "new-key" } : l));
    expect(w.auto.autoJoins("chat-owner")).toBe(false);
  });

  it("an invitation over a granted chat kept beside another contact's under the same id is the one taken; the CLI shows both", async () => {
    // The engine's invitations with the wiring `openHost` makes: another contact who knows the group's id invites first.
    const admin = createIdentity().pubKeyZ32, g = "G".repeat(22);
    const frames: [string, Record<string, unknown>][] = [];
    const stored = new Map<string, StoredGroup>();
    const store: GroupStore = { getGroups: async () => [], putGroup: async (x) => { stored.set(x.id, structuredClone(x)); }, deleteGroup: async (gid) => { stored.delete(gid); }, getMessages: async () => [] };
    const host = { sendOnLink: (linkId: string, frame: Record<string, unknown>) => { frames.push([linkId, frame]); }, linkReady: () => true, contactName: () => undefined, edges: () => new Map(), entries: () => new Map(), openEdge: async () => "", closeEdge: async () => {},
      openEntry: async () => "", publish: async () => {}, resolve: async () => null, edgeNick: () => undefined, storeMessage: async () => {}, emit: () => {} } as unknown as GroupsHost;
    const groups = new Groups(host, store);
    const links = [link("chat-owner", OWNER, { label: "Miguel" }), link("chat-other", OTHER)];
    const state = () => ({ links, groups: groups.views() }) as unknown as EngineState;
    const engine = { chatView: chatViewOf, getState: state, acceptGroupInvitation: vi.fn(({ groupId }: { groupId: string }) => groups.accept(groupId)),
      switchGroup: vi.fn(({ groupId, to }: { groupId: string; to: string }) => groups.switchGroup(groupId, to)) };
    const lines: string[] = [];
    const auto = new GroupAutoJoin({ engine, profileDir: mkdtempSync(join(tmpdir(), "ghostly-group-auto-")), joins: true, log: (line) => lines.push(line) });
    auto.set({ on: true, from: ["Miguel"] });
    await groups.handleContactFrame("chat-other", { t: "group-invite", g, name: "Team", admin, e: 0, n: 3 });
    await groups.handleContactFrame("chat-owner", { t: "group-invite", g, name: "Team", admin, e: 0, n: 3 });
    expect(groups.views()[0]).toMatchObject({ invitation: { linkId: "chat-other" }, others: [{ linkId: "chat-owner" }] });
    // What `group show` prints: the one held, and the one beside it with the chat it came over.
    expect(groupJson(groups.views()[0])).toMatchObject({ invitation: { chat: "chat-other" }, others: [{ chat: "chat-owner", name: "Team", members: 3 }] });

    auto.check(state());
    await vi.waitFor(() => expect(engine.acceptGroupInvitation).toHaveBeenCalledWith({ groupId: g }));
    expect(engine.switchGroup).toHaveBeenCalledWith({ groupId: g, to: "chat-owner" });
    expect(groups.views()[0]).toMatchObject({ invitation: { linkId: "chat-owner", accepted: true } });
    expect(groups.views()[0].others).toBeUndefined();
    // The other contact is told no; the owner hears the accept.
    expect(frames.map(([linkId, frame]) => [linkId, frame.t])).toEqual([["chat-other", "group-decline"], ["chat-owner", "group-accept"]]);
    expect(lines).toEqual([`group auto: accepted the invitation to group ${g} from chat chat-owner (another contact's under the same id declined)`]);
  });

  it("an invitation over a granted chat beside a re-invitation that keeps a group this device was in is not taken: the group and its history stay", async () => {
    // The engine with the wiring `openHost` makes: removed from a group, invited to it again over another chat, then a
    // granted contact's invitation comes under the same id with an admin of its own.
    const g = "K".repeat(22), now = Date.now();
    const identity = identityFromSeedB64(toBase64Url(randomBytes(32))), secret = newEpochSecret();
    const draft: Omit<GroupCommit, "sig" | "c"> = { v: 1, g, e: 0, p: "", k: "create", m: [[identity.pubKeyZ32, "admin"]], by: identity.pubKeyZ32, ts: now };
    const commit = signCommit({ ...draft, c: confirmationTag(epochKeys(secret, g, 0).confirm, commitUntaggedHash(draft)) }, identity.seed);
    const removed = { id: g, name: "Team", profile: GROUP_PROFILE, seedB64: toBase64Url(randomBytes(32)), createdAt: now, chain: [commit], secrets: { 0: toBase64Url(secret) },
      status: "removed", seq: 0, seqEpoch: 0, sent: [], seen: {}, nicks: {} } as unknown as GroupState;
    const frames: [string, Record<string, unknown>][] = [];
    const stored = new Map<string, StoredGroup>([[g, { id: g, createdAt: now, state: removed, contacts: {} }]]);
    const deleted: string[] = [];
    const store: GroupStore = { getGroups: async () => [...stored.values()].map((x) => structuredClone(x)), putGroup: async (x) => { stored.set(x.id, structuredClone(x)); },
      deleteGroup: async (gid) => { deleted.push(gid); stored.delete(gid); }, getMessages: async () => [] };
    const host = { sendOnLink: (linkId: string, frame: Record<string, unknown>) => { frames.push([linkId, frame]); }, linkReady: () => true, contactName: () => undefined, edges: () => new Map(), entries: () => new Map(), openEdge: async () => "", closeEdge: async () => {},
      openEntry: async () => "", publish: async () => {}, resolve: async () => null, edgeNick: () => undefined, storeMessage: async () => {}, emit: () => {} } as unknown as GroupsHost;
    const groups = new Groups(host, store);
    await groups.load();
    const links = [link("chat-owner", OWNER, { label: "Miguel" }), link("chat-other", OTHER)];
    const state = () => ({ links, groups: groups.views() }) as unknown as EngineState;
    const engine = { chatView: chatViewOf, getState: state, acceptGroupInvitation: vi.fn(({ groupId }: { groupId: string }) => groups.accept(groupId)),
      switchGroup: vi.fn(({ groupId, to }: { groupId: string; to: string }) => groups.switchGroup(groupId, to)) };
    const lines: string[] = [];
    const auto = new GroupAutoJoin({ engine, profileDir: mkdtempSync(join(tmpdir(), "ghostly-group-auto-")), joins: true, log: (line) => lines.push(line) });
    auto.set({ on: true, from: ["Miguel"] });
    await groups.handleContactFrame("chat-other", { t: "group-invite", g, name: "Team", admin: identity.pubKeyZ32, e: 0, n: 3 });
    expect(stored.get(g)?.previous?.state).toBeDefined();
    await groups.handleContactFrame("chat-owner", { t: "group-invite", g, name: "Fake", admin: createIdentity().pubKeyZ32, e: 0, n: 2 });
    expect(groups.views()[0]).toMatchObject({ invitation: { linkId: "chat-other", kept: true }, others: [{ linkId: "chat-owner" }] });

    frames.length = 0;
    auto.check(state());
    auto.check(state());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(engine.switchGroup).not.toHaveBeenCalled();
    expect(engine.acceptGroupInvitation).not.toHaveBeenCalled();
    expect(frames).toEqual([]);
    expect(deleted).toEqual([]);
    expect(stored.get(g)).toMatchObject({ invitation: { linkId: "chat-other" }, previous: { state: { status: "removed" } } });
    expect(lines).toEqual([`group auto: an invitation to group ${g} from chat chat-owner is kept beside another group under the same id: it waits for you (ghostly group show ${g})`]);
    // Declined by the person, the removed group comes back with its history.
    await groups.decline(g);
    expect(stored.get(g)?.state?.status).toBe("removed");
  });

  it("an invitation over a granted chat beside a group already joined or accepted is not taken: it waits for the person, said once", async () => {
    const w = world();
    w.auto.set({ on: true, from: ["Miguel"] });
    const other = { linkId: "chat-owner", contact: "Miguel", name: "Team", members: 3 };
    w.s.groups = [{ ...invited("g-in", "chat-other"), status: "active", others: [other] } as GroupView, { ...invited("g-accepted", "chat-other", { accepted: true }), others: [other] } as GroupView,
      { ...invited("g-not-granted", "chat-owner"), others: [{ ...other, linkId: "chat-other" }] } as GroupView];
    w.auto.check(w.state());
    w.auto.check(w.state());
    await Promise.resolve();
    expect(w.engine.switchGroup).not.toHaveBeenCalled();
    // The one held over the granted chat is accepted as before; another contact's beside it is left alone.
    expect(w.engine.acceptGroupInvitation).toHaveBeenCalledTimes(1);
    expect(w.engine.acceptGroupInvitation).toHaveBeenCalledWith({ groupId: "g-not-granted" });
    expect(w.lines.filter((line) => line.includes("waits for you"))).toEqual([
      "group auto: an invitation to group g-in from chat chat-owner is kept beside another group under the same id: it waits for you (ghostly group show g-in)",
      "group auto: an invitation to group g-accepted from chat chat-owner is kept beside another group under the same id: it waits for you (ghostly group show g-accepted)",
    ]);
  });

  it("a one-shot only keeps the setting: it accepts nothing itself", async () => {
    const w = world(undefined, false);
    w.s.groups = [invited("g1", "chat-owner")];
    w.auto.set({ on: true, from: ["chat-owner"] });
    w.auto.check(w.state());
    await Promise.resolve();
    expect(w.engine.acceptGroupInvitation).not.toHaveBeenCalled();
    expect(world(w.dir).auto.get()).toEqual({ on: true, from: ["chat-owner"] });
  });

  it("a removed chat leaves the list; the last one turns it off; off forgets them all", () => {
    const w = world();
    w.auto.set({ on: true, from: ["chat-owner"] });
    w.auto.forgetChat("chat-other");
    expect(w.auto.get()).toEqual({ on: true, from: ["chat-owner"] });
    w.auto.forgetChat("chat-owner");
    expect(w.auto.get()).toEqual({ on: false, from: [] });
    w.auto.set({ on: true, from: ["chat-owner"] });
    expect(w.auto.set({ on: false })).toEqual({ on: false, from: [] });
  });

  it("each on names every chat: a new on replaces the list, as call auto on --from does (docs/CLI.md says so)", () => {
    const w = world();
    expect(w.auto.set({ on: true, from: ["chat-owner"] })).toEqual({ on: true, from: ["chat-owner"] });
    expect(w.auto.set({ on: true, from: ["chat-other"] })).toEqual({ on: true, from: ["chat-other"] });
    expect(w.auto.set({ on: true, from: ["chat-owner", "chat-other"] })).toEqual({ on: true, from: ["chat-owner", "chat-other"] });
    const docs = readFileSync(join(import.meta.dirname, "../../../docs/CLI.md"), "utf8").replace(/\s+/g, " ");
    expect(docs).not.toContain("--from <chat>` (again for more chats)");
    expect(docs).toContain("a new `group auto on` replaces the list");
  });

  it("over the API: group.auto reads and sets it, group.list shows it, chat.remove forgets the chat", async () => {
    const w = world();
    Object.assign(w.engine, { removeLink: vi.fn(async () => undefined), removalsPending: () => [] });
    const ctx = { runtime: { server: { node: w.engine }, paths: { name: "default" } }, calls: { list: () => [], forgetChat: () => {} }, groupAuto: w.auto, mode: "daemon", version: "test" } as unknown as ApiContext;
    expect(await callApi(ctx, "group.auto", {})).toEqual({ autoJoin: { on: false, from: [] } });
    await expect(callApi(ctx, "group.auto", { on: true })).rejects.toMatchObject({ code: "bad_request" });
    expect(await callApi(ctx, "group.auto", { on: true, from: ["Miguel"] })).toEqual({ autoJoin: { on: true, from: ["chat-owner"] } });
    expect(await callApi(ctx, "group.list", {})).toMatchObject({ autoJoin: { on: true, from: ["chat-owner"] } });
    await callApi(ctx, "chat.remove", { chat: "chat-owner", yes: true });
    expect(await callApi(ctx, "group.auto", {})).toEqual({ autoJoin: { on: false, from: [] } });
  });

  it("over the API: the chats of group.auto and call.auto go with on: true, as the command line refuses them without on", async () => {
    // Found in a bug hunt: from with on: false emptied the whole list (a bot dropping one chat dropped them all), and from
    // with no on only read the setting: each answered as if done.
    const w = world();
    const calls = new CallManager({ engine: { chatView: chatViewOf, getState: w.state, setCallSignal: async () => {} } as unknown as CallEngine, emit: () => {}, profileDir: w.dir });
    const ctx = { runtime: { server: { node: w.engine }, paths: { name: "default" } }, calls, groupAuto: w.auto, mode: "daemon", version: "test" } as unknown as ApiContext;
    expect(await callApi(ctx, "group.auto", { on: true, from: ["Miguel"] })).toEqual({ autoJoin: { on: true, from: ["chat-owner"] } });
    expect(await callApi(ctx, "call.auto", { on: true, from: ["Miguel"], rate: 16000 })).toEqual({ autoAnswer: { on: true, from: ["chat-owner"], rate: 16000 } });
    for (const params of [{ on: false, from: ["Miguel"] }, { from: ["Miguel"] }, { on: null, from: ["Miguel"] }]) {
      await expect(callApi(ctx, "group.auto", params), JSON.stringify(params)).rejects.toMatchObject({ code: "bad_request", message: "from goes with on: true" });
      await expect(callApi(ctx, "call.auto", params), JSON.stringify(params)).rejects.toMatchObject({ code: "bad_request", message: "from and rate go with on: true" });
    }
    for (const params of [{ on: false, rate: 16000 }, { rate: 16000 }])
      await expect(callApi(ctx, "call.auto", params), JSON.stringify(params)).rejects.toMatchObject({ code: "bad_request", message: "from and rate go with on: true" });
    expect(await callApi(ctx, "group.auto", {})).toEqual({ autoJoin: { on: true, from: ["chat-owner"] } });
    expect(await callApi(ctx, "call.auto", {})).toEqual({ autoAnswer: { on: true, from: ["chat-owner"], rate: 16000 } });
    // Off alone, or with an empty list, still turns each off; a word for on is refused as before.
    expect(await callApi(ctx, "group.auto", { on: false, from: [] })).toEqual({ autoJoin: { on: false, from: [] } });
    expect(await callApi(ctx, "call.auto", { on: false })).toEqual({ autoAnswer: { on: false, from: [], rate: 48000 } });
    await expect(callApi(ctx, "group.auto", { on: "false", from: ["Miguel"] })).rejects.toMatchObject({ code: "bad_request", message: "on must be true or false" });
  });

  it("the command: on needs --from, --from goes with on only", () => {
    const params = (argv: string[]) => {
      const command = COMMANDS["group auto"];
      const parsed = parseArgs(argv, command.options ?? {}, idSlot(command));
      return command.params!(parsed, positionals(command, parsed.positionals));
    };
    const usage = (argv: string[]) => { try { params(argv); } catch (error) { expect(error).toBeInstanceOf(CliError); expect((error as CliError).code).toBe("usage"); return (error as CliError).message; } return expect.fail("no usage error"); };
    expect(params([])).toEqual({});
    expect(params(["on", "--from", "Miguel", "--from", "chat-two"])).toEqual({ on: true, from: ["Miguel", "chat-two"] });
    expect(params(["off"])).toEqual({ on: false });
    expect(usage(["on"])).toBe("group auto on needs the chats whose invitations it accepts: ghostly group auto on --from <chat>");
    expect(usage(["off", "--from", "x"])).toBe("--from goes with on: ghostly group auto on --from <chat>");
    expect(usage(["maybe"])).toMatch(/^group auto takes on or off/);
    expect(usage(["on", "--from", ""])).toBe("--from \"\" names no chat");
  });
});

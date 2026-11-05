import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { EngineState, GroupView, LinkView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { parseArgs } from "../src/args";
import { idSlot, positionals, COMMANDS } from "../src/commands";
import { CliError } from "../src/errors";
import { GroupAutoJoin } from "../src/groupAuto";
// covers: headless.group-auto

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
    getState: () => s as unknown as EngineState,
    acceptGroupInvitation: vi.fn(async ({ groupId }: { groupId: string }) => {
      s.groups = s.groups.map((g) => (g.id === groupId ? { ...g, invitation: { ...g.invitation!, accepted: true } } : g));
    }),
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

  it("a one-shot only keeps the setting: it accepts nothing itself", async () => {
    const w = world(undefined, false);
    w.s.groups = [invited("g1", "chat-owner")];
    w.auto.set({ on: true, from: ["chat-owner"] });
    w.auto.check(w.state());
    await Promise.resolve();
    expect(w.engine.acceptGroupInvitation).not.toHaveBeenCalled();
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

  it("over the API: group.auto reads and sets it, group.list shows it, chat.remove forgets the chat", async () => {
    const w = world();
    Object.assign(w.engine, { removeLink: vi.fn(async () => undefined) });
    const ctx = { runtime: { server: { node: w.engine }, paths: { name: "default" } }, calls: { list: () => [], forgetChat: () => {} }, groupAuto: w.auto, mode: "daemon", version: "test" } as unknown as ApiContext;
    expect(await callApi(ctx, "group.auto", {})).toEqual({ autoJoin: { on: false, from: [] } });
    await expect(callApi(ctx, "group.auto", { on: true })).rejects.toMatchObject({ code: "bad_request" });
    expect(await callApi(ctx, "group.auto", { on: true, from: ["Miguel"] })).toEqual({ autoJoin: { on: true, from: ["chat-owner"] } });
    expect(await callApi(ctx, "group.list", {})).toMatchObject({ autoJoin: { on: true, from: ["chat-owner"] } });
    await callApi(ctx, "chat.remove", { chat: "chat-owner", yes: true });
    expect(await callApi(ctx, "group.auto", {})).toEqual({ autoJoin: { on: false, from: [] } });
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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { EngineState, GroupView, LinkView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { CallManager, type CallEngine } from "../src/calls/manager";
import { jsonOut } from "../src/jsonOut";
import { allowlist } from "../src/listen";
import { chatViewOf, groupViewOf } from "./support/chatView";
import { pasted } from "./support/pasted";
// covers: headless.groups

/**
 * A command that takes only a 1:1 chat, given a group's name or id: it says the ref is a group, as the chat commands
 * with a group twin do (`send`, `react`), where it read `No chat "Crew"`, as if nothing had that name. A name nothing
 * has stays `No chat`.
 */
const alice = { id: "chat-one", label: "Alice", peerPubKeyZ32: "palice", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", textDelivery: "stream", pairing: { status: "ready" } } as unknown as LinkView;
const crew = { id: "g1crew", name: "Crew", createdAt: 1, profile: "mesh", isAdmin: true, canSend: true, lastMessageAt: 0, invited: [], memberLinks: {},
  members: [{ key: "mekey", role: "admin", me: true, online: true, missing: 0 }] } as unknown as GroupView;
const state = () => ({ links: [alice], groups: [crew], settings: {}, transport: {}, identityProofs: [{ id: "proof1" }] }) as unknown as EngineState;

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function fake(): ApiContext {
  const node = { chatView: chatViewOf, groupView: groupViewOf, getState: state, inviteToGroup: vi.fn(), shareIdentityProof: vi.fn(), setServiceShared: vi.fn(), renameLink: vi.fn() };
  const dir = mkdtempSync(join(tmpdir(), "gnc-"));
  dirs.push(dir);
  const calls = new CallManager({ engine: { chatView: chatViewOf, groupView: groupViewOf, getState: state, setCallSignal: async () => {} } as unknown as CallEngine, emit: () => {}, profileDir: dir });
  return { runtime: { server: { node }, paths: { name: "default", dir }, callsUnavailable: null }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, calls, mode: "daemon", version: "test" } as unknown as ApiContext;
}

const isGroup = (ref: string) => ({ code: "not_found", message: `${JSON.stringify(ref)} is a group, not a chat (ghostly chat list)`, details: { group: "g1crew" } });
const noChat = (ref: string) => ({ code: "not_found", message: `No chat ${JSON.stringify(ref)} (ghostly chat list)` });

describe("a group named where only a 1:1 chat goes", () => {
  it.each([
    ["chat.connect", {}],
    ["chat.disconnect", {}],
    ["chat.transport", { transport: "auto" }],
    ["chat.verify", { code: "123" }],
    ["chat.wait", { until: "live", timeout: 1 }],
    ["chat.accept", {}],
    ["chat.pay", { sats: 10 }],
    ["chat.request", { sats: 10 }],
    ["chat.payRequest", { payment: "p1" }],
    ["payment.check", { payment: "p1" }],
    ["identity.contact", {}],
    ["identity.recheck", { id: "x" }],
    ["identity.share", { id: "proof1" }],
    ["identity.withdraw", { id: "proof1" }],
    ["service.peer", {}],
    ["call.start", {}],
  ] as const)("%s says it is a group", async (method, params) => {
    const ctx = fake();
    for (const ref of ["Crew", "crew", "g1crew", "g1c", "group:g1crew"]) await expect(callApi(ctx, method, { chat: ref, ...params })).rejects.toMatchObject(isGroup(ref));
    await expect(callApi(ctx, method, { chat: "Nobody", ...params })).rejects.toMatchObject(noChat("Nobody"));
  });

  it("the contact of group invite, payment list --chat, call answer and call auto --from say it too", async () => {
    const ctx = fake();
    await expect(callApi(ctx, "group.invite", { group: "Crew", chat: "Crew" })).rejects.toMatchObject(isGroup("Crew"));
    await expect(callApi(ctx, "payment.list", { chat: "Crew" })).rejects.toMatchObject(isGroup("Crew"));
    await expect(callApi(ctx, "call.answer", { call: "Crew" })).rejects.toMatchObject(isGroup("Crew"));
    await expect(callApi(ctx, "call.auto", { on: true, from: ["Crew"] })).rejects.toMatchObject(isGroup("Crew"));
    await expect(callApi(ctx, "service.share", { service: "web", chat: "Crew" })).rejects.toMatchObject(isGroup("Crew"));
  });
});

describe("group:<ref> where only a 1:1 chat goes, beside a contact that calls itself so", () => {
  // Bob chose his own name; this side gave his chat no label. Carol's chat has the label `group:Crew` given here.
  const bob = (nick: string) => ({ ...alice, id: "chat-bob", label: undefined, peerNick: nick, peerPubKeyZ32: "pbob" }) as unknown as LinkView;
  const withBob = (nick: string): ApiContext => {
    const ctx = fake();
    const node = (ctx.runtime as unknown as { server: { node: { getState: () => EngineState } } }).server.node;
    node.getState = () => ({ ...state(), links: [alice, bob(nick)] }) as unknown as EngineState;
    return ctx;
  };

  it.each([
    ["chat.send", { text: "hi" }, "group send Crew [text...]"],
    ["chat.get", {}, "group show Crew"],
    ["chat.remove", { yes: true }, "group forget Crew --yes"],
  ] as const)("%s refuses it as the group, whatever the contact calls itself", async (method, params, command) => {
    for (const nick of ["group:Crew", "group:crew"]) {
      await expect(callApi(withBob(nick), method, { chat: "group:Crew", ...params })).rejects.toMatchObject({
        code: "not_found", message: `"group:Crew" is a group, not a chat: ghostly ${command}`, details: { group: "g1crew" },
      });
    }
    await expect(callApi(withBob("group:g1crew"), method, { chat: "group:g1crew", ...params })).rejects.toMatchObject({ code: "not_found", details: { group: "g1crew" } });
    // A group nobody here is in: no chat, not Bob's.
    await expect(callApi(withBob("group:Zed"), method, { chat: "group:Zed", ...params })).rejects.toMatchObject({ code: "not_found", message: expect.stringContaining('"group:Zed"') });
  });

  it.each([
    ["chat.request", { sats: 21 }],
    ["chat.accept", {}],
    ["chat.pay", { sats: 21 }],
    ["call.start", {}],
  ] as const)("%s refuses it as the group", async (method, params) => {
    await expect(callApi(withBob("group:Crew"), method, { chat: "group:Crew", ...params })).rejects.toMatchObject(isGroup("group:Crew"));
    await expect(callApi(withBob("group:Zed"), method, { chat: "group:Zed", ...params })).rejects.toMatchObject(noChat("group:Zed"));
  });

  it("payment list --chat refuses it too", async () => {
    await expect(callApi(withBob("group:Crew"), "payment.list", { chat: "group:Crew" })).rejects.toMatchObject(isGroup("group:Crew"));
  });

  it("a label given here does not name the chat either: the group, as send reads it; the chat by its id", async () => {
    // A chat labelled `group:...` before such names were refused: one target per ref, the group, as `send` takes it.
    const labelled = (label: string): ApiContext => {
      const ctx = fake();
      const node = (ctx.runtime as unknown as { server: { node: { getState: () => EngineState } } }).server.node;
      node.getState = () => ({ ...state(), links: [alice, { ...bob("Carol"), id: "chat-carol", label }] }) as unknown as EngineState;
      return ctx;
    };
    await expect(callApi(labelled("group:Crew"), "chat.connect", { chat: "group:Crew" })).rejects.toMatchObject(isGroup("group:Crew"));
    for (const method of ["chat.get", "chat.history"]) {
      await expect(callApi(labelled("group:Crew"), method, { chat: "group:Crew" })).rejects.toMatchObject({ code: "not_found", details: { group: "g1crew" } });
    }
    // No such group: refused, naming the chat so labelled, never taken for it.
    await expect(callApi(labelled("group:Zed"), "chat.connect", { chat: "group:Zed" })).rejects.toMatchObject({
      code: "not_found", message: expect.stringContaining('"group:Zed" names a group, never a chat'), details: { matches: ["chat-carol"] },
    });
    expect(await callApi(labelled("group:Zed"), "chat.get", { chat: "chat-carol" })).toMatchObject({ id: "chat-carol" });
    const renamed = labelled("group:Zed");
    await callApi(renamed, "chat.rename", { chat: "chat-carol", name: "Carol" });
    expect((renamed.runtime as unknown as { server: { node: { renameLink: ReturnType<typeof vi.fn> } } }).server.node.renameLink).toHaveBeenCalledWith({ linkId: "chat-carol", label: "Carol" });
  });

  it("chat rename and invite create --label refuse a name starting with group:", async () => {
    for (const name of ["group:Crew", " group:x", "group:"]) {
      await expect(callApi(fake(), "chat.rename", { chat: "Alice", name })).rejects.toMatchObject({ code: "bad_request", message: expect.stringContaining('"group:"') });
      await expect(callApi(fake(), "invite.create", { label: name })).rejects.toMatchObject({ code: "bad_request", message: expect.stringContaining('"group:"') });
    }
  });
});

describe("listen --from a group, --group a chat", () => {
  const call = (method: string, params: Record<string, unknown>) => callApi(fake(), method, params);

  it("names the flag that takes it, not chat show or group show", async () => {
    await expect(allowlist(["Crew"], [], call, async () => null)).rejects.toMatchObject({
      code: "not_found", message: '"Crew" is a group, not a chat: ghostly listen --group Crew', details: { group: "g1crew" },
    });
    await expect(allowlist([], ["Alice"], call, async () => null)).rejects.toMatchObject({
      code: "not_found", message: '"Alice" is a chat, not a group: ghostly listen --from chat-one', details: { chat: "chat-one" },
    });
    await expect(allowlist(["Nobody"], [], call, async () => null)).rejects.toMatchObject(noChat("Nobody"));
  });

  it("--group a chat names it by its id, which --from takes, never by the name its contact chose or a prefix", async () => {
    // Bob chose his own name; this side gave his chat no label. `--from Bob` or `--from chat-b` is refused.
    const bob = { ...alice, id: "chat-bob", label: undefined, peerNick: "Bob", peerPubKeyZ32: "pbob" } as unknown as LinkView;
    const withBob = (method: string, params: Record<string, unknown>) => {
      const ctx = fake();
      (ctx.runtime as unknown as { server: { node: { getState: () => EngineState } } }).server.node.getState = () => ({ ...state(), links: [alice, bob] }) as unknown as EngineState;
      return callApi(ctx, method, params);
    };
    for (const ref of ["Bob", "chat-b"]) {
      await expect(allowlist([], [ref], withBob, async () => null)).rejects.toMatchObject({
        code: "not_found", message: `"${ref}" is a chat, not a group: ghostly listen --from chat-bob`, details: { chat: "chat-bob" },
      });
      await expect(allowlist([ref], [], withBob, async () => null)).rejects.toMatchObject({ details: { chat: "chat-bob" } });
    }
    expect(await allowlist(["chat-bob"], [], withBob, async () => null)).toBeDefined();
  });
});

describe("a hint naming a group a shell would expand", () => {
  // `"$5 lunch"` pasted into a shell named ` lunch`; a backtick in the name ran a command.
  const call = (name: string) => (method: string, params: Record<string, unknown>) => {
    const ctx = fake();
    const node = (ctx.runtime as unknown as { server: { node: { getState: () => EngineState } } }).server.node;
    node.getState = () => ({ ...state(), groups: [{ ...crew, name }] }) as unknown as EngineState;
    return callApi(ctx, method, params);
  };
  /** The command line the refusal offers, as a shell reads it pasted. */
  const offered = async (refusal: Promise<unknown>) => {
    const message = await refusal.then(() => "", (error: Error) => error.message);
    expect(message).toContain(": ghostly ");
    return pasted(message.slice(message.indexOf(": ghostly ") + 2));
  };

  it.each(["$5 lunch", "a`echo x`b", "x!y"])("%s: the command offered names the same group", async (name) => {
    expect(await offered(call(name)("chat.send", { chat: name, text: "hi" }))).toEqual(["ghostly", "group", "send", name, "[text...]"]);
    expect(await offered(call(name)("chat.history", { chat: name }))).toEqual(["ghostly", "group", "history", name]);
    expect(await offered(allowlist([name], [], call(name), async () => null))).toEqual(["ghostly", "listen", "--group", name]);
  });

  /**
   * The command line as the terminal shows it: the CLI prints every answer, a refusal too, as JSON, which shows the `\`
   * of a `'\''` doubled. Pasted, the quote ended there and the rest of the name ran, a name its inviter chose.
   */
  const printed = async (refusal: Promise<unknown>) => {
    const message = await refusal.then(() => "", (error: Error) => error.message);
    const shown = jsonOut(message).slice(1, -1);
    expect(shown).toContain(": ghostly ");
    return pasted(shown.slice(shown.indexOf(": ghostly ") + 2).replace(/ (joins it|\[text\.\.\.\])$/, ""));
  };

  it.each(["it's", "a'; echo ran; 'b", "a\"b", "a\\b"])("%s: the command printed names the group by its id, pasted as one word", async (name) => {
    expect(await printed(call(name)("chat.send", { chat: name, text: "hi" }))).toEqual(["ghostly", "group", "send", "g1crew"]);
    expect(await printed(allowlist([name], [], call(name), async () => null))).toEqual(["ghostly", "listen", "--group", "g1crew"]);
    expect(await printed(call(name)("chat.history", { chat: name }))).toEqual(["ghostly", "group", "history", "g1crew"]);
  });
});

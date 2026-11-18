import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { EngineState, GroupView, LinkView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { CallManager, type CallEngine } from "../src/calls/manager";
import { EXIT } from "../src/errors";
import { GroupAutoJoin, type GroupAutoEngine } from "../src/groupAuto";
import { allowlist } from "../src/listen";
import { chatViewOf, groupViewOf } from "./support/chatView";
// covers: headless.groups

/**
 * A name more than one group has is one refusal wherever a chat or a group is looked for: `bad_request`, exit 1, as
 * every group command gives it. The chat commands with a group twin (`send`, `react`, `edit`, `typing`, `chat show`,
 * `message delete`, so `listen --from` too) and the ones that take only a chat answered it `not_found`, exit 3, so a
 * script read "nothing has that name" for the same name `group show` called ambiguous.
 */
const alice = { id: "chat-one", label: "Alice", peerPubKeyZ32: "palice", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", textDelivery: "stream", pairing: { status: "ready" } } as unknown as LinkView;
const group = (id: string, name = "zz") => ({ id, name, createdAt: 1, profile: "mesh", isAdmin: true, canSend: true, lastMessageAt: 0, invited: [], memberLinks: {},
  members: [{ key: "mekey", role: "admin", me: true, online: true, missing: 0 }] }) as unknown as GroupView;
const state = () => ({ links: [alice], groups: [group("g1zz"), group("g2zz"), group("g3one", "Solo")], settings: {}, transport: {}, identityProofs: [{ id: "proof1" }] }) as unknown as EngineState;

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function fake(): ApiContext {
  const node = { chatView: chatViewOf, groupView: groupViewOf, getState: state, shareIdentityProof: vi.fn() };
  const dir = mkdtempSync(join(tmpdir(), "gsnc-"));
  dirs.push(dir);
  const calls = new CallManager({ engine: { chatView: chatViewOf, groupView: groupViewOf, getState: state, setCallSignal: async () => {} } as unknown as CallEngine, emit: () => {}, profileDir: dir });
  const groupAuto = new GroupAutoJoin({ engine: { getState: state } as unknown as GroupAutoEngine, profileDir: dir, joins: false });
  const store = { compact: vi.fn(async () => {}) };
  return { runtime: { server: { node }, store, paths: { name: "default", dir }, callsUnavailable: null }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, calls, groupAuto, mode: "daemon", version: "test" } as unknown as ApiContext;
}

type Refusal = { code: keyof typeof EXIT; message: string; details?: Record<string, unknown> };
const refusal = (run: Promise<unknown>) => run.then(() => { throw new Error("not refused"); }, (error: Refusal) => error);

describe("a name more than one group has: one code, chat and group commands alike", () => {
  it.each([
    ["send", "chat.send", { chat: "zz", text: "hi" }],
    ["react", "chat.react", { chat: "zz", message: "m1", emoji: "👍" }],
    ["edit", "chat.edit", { chat: "zz", message: "m1", text: "hi" }],
    ["typing", "chat.typing", { chat: "zz" }],
    ["chat show", "chat.get", { chat: "zz" }],
    ["message delete", "chat.delete", { chat: "zz", message: "m1" }],
    ["message delete group:", "chat.delete", { chat: "group:zz", message: "m1" }],
    ["call start", "call.start", { chat: "zz" }],
    ["chat verify", "chat.verify", { chat: "zz", code: "1234" }],
    ["identity share", "identity.share", { chat: "zz", id: "proof1" }],
    ["group auto on --from", "group.auto", { on: true, from: ["zz"] }],
    // Already so: every group command, and the commands that take a chat or a group.
    ["group show", "group.get", { group: "zz" }],
    ["pin", "chat.pin", { chat: "zz", message: "m1" }],
    ["file send", "file.send", { chat: "zz", path: "/nonexistent" }],
    ["saved add", "saved.add", { chat: "zz", message: "m1" }],
    ["message delete --everyone", "chat.delete", { chat: "zz", message: "m1", everyone: true }],
  ] as const)("%s: bad_request, exit 1", async (_, method, params) => {
    const error = await refusal(callApi(fake(), method, params));
    expect(error.message).toMatch(/names more than one group/);
    expect(error.code).toBe("bad_request");
    expect(EXIT[error.code]).toBe(1);
    // The ids to choose from, as `group show zz` gives them.
    expect(error.details?.matches).toEqual(["g1zz", "g2zz"]);
  });

  it("message delete --purge folds nothing for it, as for any bad_request", async () => {
    const ctx = fake();
    const error = await refusal(callApi(ctx, "chat.delete", { chat: "zz", message: "m1", purge: true }));
    expect(error.code).toBe("bad_request");
    expect(error.message).not.toMatch(/folded anyway/);
    expect((ctx.runtime.store as unknown as { compact: ReturnType<typeof vi.fn> }).compact).not.toHaveBeenCalled();
  });

  it.each([
    ["listen --from", ["zz"], []],
    ["listen --group", [], ["zz"]],
  ] as const)("%s: bad_request, exit 1", async (_, from, groups) => {
    const ctx = fake();
    const error = await refusal(allowlist(from, groups, (method, params) => callApi(ctx, method, params), async () => null));
    expect(error.message).toMatch(/names more than one group/);
    expect(error.code).toBe("bad_request");
    expect(EXIT[error.code]).toBe(1);
    // The ids to choose from, as `group show zz` gives them.
    expect(error.details?.matches).toEqual(["g1zz", "g2zz"]);
  });

  it("one group's name, and a name nothing has, keep not_found (exit 3)", async () => {
    for (const method of ["chat.send", "chat.get", "call.start", "chat.verify"] as const) {
      const one = await refusal(callApi(fake(), method, { chat: "Solo", text: "hi", code: "1234" }));
      expect(one.message).toMatch(/^"Solo" is a group, not a chat/);
      expect(one.code).toBe("not_found");
      const none = await refusal(callApi(fake(), method, { chat: "Nobody", text: "hi", code: "1234" }));
      expect(none.code).toBe("not_found");
      expect(EXIT[none.code]).toBe(3);
    }
  });

  it("a name more than one chat has stays that chat refusal, not the groups'", async () => {
    const twoChats = () => ({ ...state(), links: [alice, { ...alice, id: "chat-two", peerPubKeyZ32: "pbob", label: "zz" }, { ...alice, id: "chat-three", peerPubKeyZ32: "pcarol", label: "zz" }] }) as unknown as EngineState;
    const ctx = fake();
    (ctx.runtime.server.node as unknown as { getState: () => EngineState }).getState = twoChats;
    const error = await refusal(callApi(ctx, "chat.send", { chat: "zz", text: "hi" }));
    expect(error.message).toBe(`"zz" names more than one chat: use its id`);
    expect(error.code).toBe("bad_request");
    // `listen --from` too: the chats' ids in `matches` are not the groups', so it offers no `--group`.
    const from = await refusal(allowlist(["zz"], [], (method, params) => callApi(ctx, method, params), async () => null));
    expect(from.message).toBe(`"zz" names more than one chat: use its id`);
    expect(from.details?.matches).toEqual(["chat-two", "chat-three"]);
  });
});

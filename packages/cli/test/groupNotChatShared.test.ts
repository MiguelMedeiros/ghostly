import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { EngineState, GroupView, LinkView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { CallManager, type CallEngine } from "../src/calls/manager";
import { chatViewOf, groupViewOf } from "./support/chatView";
// covers: headless.groups

/**
 * A command that takes only a 1:1 chat, given a name two groups share: it says the name is a group's, as it does for a
 * name one group has, where it read `No chat "zz"`, as if nothing had that name (`findGroup` refuses a shared name, and
 * that refusal was taken for no group at all).
 */
const alice = { id: "chat-one", label: "Alice", peerPubKeyZ32: "palice", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", textDelivery: "stream", pairing: { status: "ready" } } as unknown as LinkView;
const group = (id: string) => ({ id, name: "zz", createdAt: 1, profile: "mesh", isAdmin: true, canSend: true, lastMessageAt: 0, invited: [], memberLinks: {},
  members: [{ key: "mekey", role: "admin", me: true, online: true, missing: 0 }] }) as unknown as GroupView;
const state = () => ({ links: [alice], groups: [group("g1zz"), group("g2zz")], settings: {}, transport: {}, identityProofs: [{ id: "proof1" }] }) as unknown as EngineState;

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function fake(): ApiContext {
  const node = { chatView: chatViewOf, groupView: groupViewOf, getState: state, shareIdentityProof: vi.fn() };
  const dir = mkdtempSync(join(tmpdir(), "gncs-"));
  dirs.push(dir);
  const calls = new CallManager({ engine: { chatView: chatViewOf, groupView: groupViewOf, getState: state, setCallSignal: async () => {} } as unknown as CallEngine, emit: () => {}, profileDir: dir });
  const store = { compact: async () => {} };
  return { runtime: { server: { node }, store, paths: { name: "default", dir }, callsUnavailable: null }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, calls, mode: "daemon", version: "test" } as unknown as ApiContext;
}

const refusal = (run: Promise<unknown>) => run.then(() => { throw new Error("not refused"); }, (error: { code: string; message: string; details?: unknown }) => error);

describe("a name two groups share, where only a 1:1 chat goes", () => {
  it.each([
    ["call.hangup", "call", {}],
    ["call.start", "chat", {}],
    ["identity.share", "chat", { id: "proof1" }],
  ] as const)("%s says it names more than one group, and where their ids are", async (method, key, params) => {
    for (const ref of ["zz", "ZZ", "group:zz"]) {
      const error = await refusal(callApi(fake(), method, { [key]: ref, ...params }));
      expect(error.message).toBe(`${JSON.stringify(ref)} names more than one group, not a chat: a group command takes one by its id (ghostly group list)`);
      expect(error.code).toBe("not_found");
    }
    // A name nothing has stays `No chat`.
    expect((await refusal(callApi(fake(), method, { [key]: "Nobody", ...params }))).message).toBe(`No chat "Nobody" (ghostly chat list)`);
  });

  it.each(["chat.connect", "chat.transport"] as const)("%s says a group has no transport of its own, and names group list, not group show", async (method) => {
    const error = await refusal(callApi(fake(), method, { chat: "zz", transport: "dht" }));
    expect(error.message).toBe(`"zz" names more than one group, not a chat: it connects through its members' chats, with no transport of its own (ghostly group list)`);
    expect(error.code).toBe("not_found");
  });

  it("react and message delete offer the group command, with the id of the group meant", async () => {
    const react = await refusal(callApi(fake(), "chat.react", { chat: "zz", message: "m1", emoji: "👍" }));
    expect(react.message).toBe(`"zz" names more than one group, not a chat: ghostly group react <group> <message> <emoji>, with the id of the group meant (ghostly group list)`);
    expect(react.code).toBe("not_found");
    const remove = await refusal(callApi(fake(), "chat.delete", { chat: "group:zz", message: "m1" }));
    expect(remove.message).toBe(`"group:zz" names more than one group, not a chat: ghostly message delete <group> m1 --everyone, with the id of the group meant (ghostly group list)`);
    expect(remove.code).toBe("not_found");
  });
});

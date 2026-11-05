import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { EngineState, GroupView, LinkView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { CallManager, type CallEngine } from "../src/calls/manager";
import { allowlist } from "../src/listen";
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
  const node = { getState: state, inviteToGroup: vi.fn(), shareIdentityProof: vi.fn(), setServiceShared: vi.fn() };
  const dir = mkdtempSync(join(tmpdir(), "gnc-"));
  dirs.push(dir);
  const calls = new CallManager({ engine: { getState: state, setCallSignal: async () => {} } as unknown as CallEngine, emit: () => {}, profileDir: dir });
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

describe("listen --from a group, --group a chat", () => {
  const call = (method: string, params: Record<string, unknown>) => callApi(fake(), method, params);

  it("names the flag that takes it, not chat show or group show", async () => {
    await expect(allowlist(["Crew"], [], call, async () => null)).rejects.toMatchObject({
      code: "not_found", message: '"Crew" is a group, not a chat: ghostly listen --group Crew', details: { group: "g1crew" },
    });
    await expect(allowlist([], ["Alice"], call, async () => null)).rejects.toMatchObject({
      code: "not_found", message: '"Alice" is a chat, not a group: ghostly listen --from Alice', details: { chat: "chat-one" },
    });
    await expect(allowlist(["Nobody"], [], call, async () => null)).rejects.toMatchObject(noChat("Nobody"));
  });
});

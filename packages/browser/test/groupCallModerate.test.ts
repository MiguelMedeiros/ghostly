import "fake-indexeddb/auto";
import { createPublicKey, verify as nodeVerify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, fromBase64Url, publicKeyFromZ32, type GroupMeta, type Roster } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { parseGroupCallRoomState, sendGroupCallModeration } from "../src/engine/groupCall";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
// covers: groups.protocol.call-moderation

/**
 * WISP 602 · Group Calls § Moderation: the group's admin asks the node its `call` names to act on a member, signed with
 * the admin's member key. The node is a fake that checks the body's exact fields and verifies the signature with
 * `node:crypto` alone, over the bytes the WISP gives.
 */

Object.defineProperty(globalThis.navigator, "storage", { value: { estimate: async () => ({ quota: 50 * 1024 ** 3, usage: 10 * 1024 ** 3 }) }, configurable: true });

const SFU = "https://call.ghostly.test";
const SPKI = Buffer.from("302a300506032b6570032100", "hex");
const FIELDS = ["act", "g", "k", "n", "room", "sig", "src", "target", "ts", "v"];

/** A node with the route: it answers the admin `admin()` with the room's state, and anyone else with the same 403. */
function fakeSfu(g: string, admin: () => string | undefined) {
  const seen: { url: string; init?: RequestInit; body: Record<string, unknown> }[] = [];
  const state = { muted: {} as Record<string, string[]>, banned: [] as string[] };
  const handler = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    seen.push({ url: String(input), init, body });
    const forbidden = () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    if (String(input) !== `${SFU}/sfu/group-moderate` || init?.method !== "POST") return new Response("", { status: 404 });
    const { k, room, act, target, src, ts, n, sig } = body as { k: string; room: string; act: string; target: string; src: string[]; ts: number; n: string; sig: string };
    if (Object.keys(body).sort().join() !== FIELDS.join() || body.v !== 1 || body.g !== g || room !== `g_${g}` || Math.abs(Date.now() / 1000 - ts) > 60) return forbidden();
    const signed = Buffer.from(JSON.stringify(["ghostly-sfu/1 moderate", SFU, g, room, k, act, target, src, ts, n]));
    const key = createPublicKey({ key: Buffer.concat([SPKI, publicKeyFromZ32(k)]), format: "der", type: "spki" });
    if (!nodeVerify(null, signed, key, fromBase64Url(sig)) || k !== admin() || target === k) return forbidden();
    if (act === "mute") state.muted[target] = [...new Set([...(state.muted[target] ?? []), ...src])].sort();
    if (act === "remove") state.banned = [...new Set([...state.banned, target])].sort();
    return Response.json({ state });
  });
  return { seen, fetch: handler };
}

describe("sending the request", () => {
  const admin = createIdentity(), target = createIdentity().pubKeyZ32, g = "oKGio6SlpqeoqaqrrK2urw";
  const send = (fetch: typeof globalThis.fetch, now?: () => number) =>
    sendGroupCallModeration({ sfu: SFU, g, seed: admin.seed, act: "mute", target, src: ["screen_share", "microphone"], fetch, ...(now && { now }) });
  const once = (response: () => Promise<Response>) => vi.fn(response) as unknown as typeof fetch;

  it("sends the WISP's body, signed over the node's origin, and answers the room's state", async () => {
    const sfu = fakeSfu(g, () => admin.pubKeyZ32);
    expect(await send(sfu.fetch as typeof fetch)).toEqual({ ok: true, state: { muted: { [target]: ["microphone", "screen_share"] }, banned: [] } });
    expect(sfu.seen).toHaveLength(1);
    expect(sfu.seen[0].body).toMatchObject({ v: 1, g, k: admin.pubKeyZ32, room: `g_${g}`, act: "mute", target, src: ["microphone", "screen_share"] });
    expect(sfu.seen[0].init).toMatchObject({ method: "POST", redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
    expect(new Headers(sfu.seen[0].init?.headers).get("Content-Type")).toBe("application/json");
  });

  it("a key the node does not take as the admin is refused, once", async () => {
    const sfu = fakeSfu(g, () => createIdentity().pubKeyZ32);
    expect(await send(sfu.fetch as typeof fetch)).toEqual({ ok: false, code: "refused" });
    expect(sfu.seen).toHaveLength(1);
  });

  it("each status says its code: 429 with its wait, 404 and 405 an older node, the rest unreachable", async () => {
    const at = Date.parse("2026-11-15T12:00:00Z");
    const limited = (header?: string) => send(once(async () => new Response("", { status: 429, ...(header !== undefined && { headers: { "Retry-After": header } }) })), () => at);
    expect(await limited("30")).toEqual({ ok: false, code: "rate_limited", retryAfter: 30 });
    expect(await limited("Sun, 15 Nov 2026 12:00:45 GMT")).toEqual({ ok: false, code: "rate_limited", retryAfter: 45 });
    expect(await limited("99999999")).toEqual({ ok: false, code: "rate_limited", retryAfter: 3600 });
    expect(await limited()).toEqual({ ok: false, code: "rate_limited", retryAfter: 60 });
    expect(await limited("soon")).toEqual({ ok: false, code: "rate_limited", retryAfter: 60 });
    for (const status of [404, 405]) expect(await send(once(async () => new Response("", { status })))).toEqual({ ok: false, code: "unsupported" });
    const unreachable = { ok: false, code: "unreachable" };
    expect(await send(once(async () => { throw new TypeError("Failed to fetch"); }))).toEqual(unreachable);
    expect(await send(once(async () => { throw new DOMException("timed out", "TimeoutError"); }))).toEqual(unreachable);
    expect(await send(once(async () => new Response("oops", { status: 500 })))).toEqual(unreachable);
    expect(await send(once(async () => new Response("not json")))).toEqual(unreachable);
    expect(await send(once(async () => Response.json({ state: { muted: {}, banned: ["nope"] } })))).toEqual(unreachable);
    expect(await send(once(async () => new Response(JSON.stringify({ state: { muted: {}, banned: [] } }).padEnd(64 * 1024 + 1))))).toEqual(unreachable);
  });

  it("reads a room's state as the WISP writes it: member keys, known sources once and sorted, empty ones left out", () => {
    const a = createIdentity().pubKeyZ32, b = createIdentity().pubKeyZ32;
    expect(parseGroupCallRoomState({ state: { muted: { [a]: ["screen_share", "camera", "camera", "screen_share_audio"], [b]: [] }, banned: [b, a, b] } }))
      .toEqual({ muted: { [a]: ["camera", "screen_share"] }, banned: [a, b].sort() });
    for (const raw of [null, {}, { state: null }, { state: { muted: [], banned: [] } }, { state: { muted: {} } }, { state: { muted: { x: ["camera"] }, banned: [] } }, { state: { muted: { [a]: "camera" }, banned: [] } }])
      expect(parseGroupCallRoomState(raw), JSON.stringify(raw)).toBeNull();
  });
});

interface Inner { groups: { communities: { session(id: string): { state: { meta?: GroupMeta }; roster: Roster; myKey: string } | undefined } } }

const nodes: GhostlyNode[] = [];
beforeEach(async () => {
  const names = Object.values(STORES) as string[];
  await transact(names as never, (s: Record<string, { clear(): void }>) => { for (const name of names) s[name].clear(); });
});
afterEach(async () => { vi.unstubAllGlobals(); for (const node of nodes.splice(0)) await node.shutdown(); });

/** A community I made (so I am its admin), with `call` naming the node when `call` is set. */
async function community(call = true) {
  await db.putSettings({ online: true, nick: "Ana", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  const transport = { publish: vi.fn(async () => {}), resolve: vi.fn(async () => null), describe: () => ({ protocol: "in-process", relays: [] }) };
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() } as never, { transport, automaticWallets: false });
  nodes.push(node);
  await node.start();
  const { groupId } = await node.createGroup({ name: "Plaza", profile: "community" });
  const session = (node as unknown as Inner).groups.communities.session(groupId)!;
  if (call) session.state.meta = { ...(session.state.meta ?? {} as GroupMeta), body: JSON.stringify({ call: { sfu: SFU } }) };
  return { node, groupId, session };
}

describe("the engine's groupCallModerate", () => {
  const target = createIdentity().pubKeyZ32;

  it("the admin's mute, remove and state reach the node as the admin's, and answer the room's state", async () => {
    const { node, groupId, session } = await community();
    const sfu = fakeSfu(groupId, () => session.myKey);
    vi.stubGlobal("fetch", sfu.fetch);
    expect(await node.groupCallModerate({ groupId, act: "mute", target, src: ["camera", "microphone", "camera"] }))
      .toEqual({ ok: true, state: { muted: { [target]: ["camera", "microphone"] }, banned: [] } });
    expect(await node.groupCallModerate({ groupId, act: "remove", target, src: ["camera"] }))
      .toEqual({ ok: true, state: { muted: { [target]: ["camera", "microphone"] }, banned: [target] } });
    expect(await node.groupCallModerate({ groupId, act: "state", target }))
      .toMatchObject({ ok: true, state: { banned: [target] } });
    expect(sfu.seen.map(s => [s.body.act, s.body.target, s.body.src])).toEqual([["mute", target, ["camera", "microphone"]], ["remove", target, []], ["state", "", []]]);
    expect(sfu.seen.every(s => s.body.k === session.myKey)).toBe(true);
  });

  it("a member who is not the admin is refused before any request leaves the app", async () => {
    const { node, groupId, session } = await community();
    const other = createIdentity().pubKeyZ32;
    session.roster.splice(0, session.roster.length, [other, "admin"], [session.myKey, "member"]);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await node.groupCallModerate({ groupId, act: "mute", target, src: ["microphone"] })).toEqual({ ok: false, code: "not_admin" });
    expect(await node.groupCallModerate({ groupId, act: "state" })).toEqual({ ok: false, code: "not_admin" });
    expect(await node.groupCallModerate({ groupId: "AAAAAAAAAAAAAAAAAAAAAA", act: "state" })).toEqual({ ok: false, code: "not_admin" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a group whose call names no node that holds is unsupported, with no request", async () => {
    const { node, groupId, session } = await community(false);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await node.groupCallModerate({ groupId, act: "remove", target })).toEqual({ ok: false, code: "unsupported" });
    session.state.meta = { ...session.state.meta!, body: JSON.stringify({ call: { sfu: "http://call.ghostly.test" } }) };
    expect(await node.groupCallModerate({ groupId, act: "remove", target })).toEqual({ ok: false, code: "unsupported" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a request that is none of the WISP's throws, and sends nothing", async () => {
    const { node, groupId, session } = await community();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const moderate = node.groupCallModerate.bind(node) as (params: Record<string, unknown>) => Promise<unknown>;
    await expect(moderate({ groupId, act: "kick", target })).rejects.toThrow("act must be one of mute, allow, remove, unban, state");
    await expect(moderate({ groupId, act: "remove" })).rejects.toThrow("target must be the key of another member");
    await expect(moderate({ groupId, act: "remove", target: session.myKey })).rejects.toThrow("target must be the key of another member");
    await expect(moderate({ groupId, act: "mute", target })).rejects.toThrow("src must list one or more of camera, microphone, screen_share");
    await expect(moderate({ groupId, act: "allow", target, src: [] })).rejects.toThrow("src must list one or more");
    await expect(moderate({ groupId, act: "mute", target, src: ["screen_share_audio"] })).rejects.toThrow("src must list one or more");
    expect(fetch).not.toHaveBeenCalled();
  });
});

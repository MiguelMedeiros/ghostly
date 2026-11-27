import "fake-indexeddb/auto";
import { createPublicKey, verify as nodeVerify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, fromBase64Url, publicKeyFromZ32, type GroupMeta } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { fetchGroupCallOccupancy } from "../src/engine/groupCall";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
// covers: groups.protocol.call-occupancy

/**
 * WISP 602 · Group Calls § Occupancy: a member asks the node its group's `call` names whether the call is on, signed
 * with its member key. The node is a fake that checks the body's exact fields and verifies the signature with
 * `node:crypto` alone, over the bytes the WISP gives.
 */

Object.defineProperty(globalThis.navigator, "storage", { value: { estimate: async () => ({ quota: 50 * 1024 ** 3, usage: 10 * 1024 ** 3 }) }, configurable: true });

const SFU = "https://call.ghostly.test";
const SPKI = Buffer.from("302a300506032b6570032100", "hex");
const FIELDS = ["g", "k", "n", "room", "sig", "ts", "v"];

/** A node with the route: it answers a request signed by `member()` with `reply`, and anyone else with the one 403. */
function fakeSfu(g: string, member: () => string | undefined, reply: Record<string, unknown> = { count: 2, since: 1794700500 }) {
  const seen: { url: string; init?: RequestInit; body: Record<string, unknown> }[] = [];
  const handler = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    seen.push({ url: String(input), init, body });
    const forbidden = () => new Response(JSON.stringify({ error: "refused" }), { status: 403 });
    if (String(input) !== `${SFU}/sfu/group-occupancy` || init?.method !== "POST") return new Response("", { status: 404 });
    const { k, room, ts, n, sig } = body as { k: string; room: string; ts: number; n: string; sig: string };
    if (Object.keys(body).sort().join() !== FIELDS.join() || body.v !== 1 || body.g !== g || room !== `g_${g}` || Math.abs(Date.now() / 1000 - ts) > 60) return forbidden();
    const signed = Buffer.from(JSON.stringify(["ghostly-sfu/1 occupancy", SFU, g, room, k, ts, n]));
    const key = createPublicKey({ key: Buffer.concat([SPKI, publicKeyFromZ32(k)]), format: "der", type: "spki" });
    if (!nodeVerify(null, signed, key, fromBase64Url(sig)) || k !== member()) return forbidden();
    return Response.json(reply);
  });
  return { seen, fetch: handler };
}

describe("asking the node", () => {
  const me = createIdentity(), g = "oKGio6SlpqeoqaqrrK2urw";
  const ask = (fetch: typeof globalThis.fetch, now?: () => number) => fetchGroupCallOccupancy({ sfu: SFU, g, seed: me.seed, fetch, ...(now && { now }) });
  const once = (response: () => Promise<Response>) => vi.fn(response) as unknown as typeof fetch;

  it("sends the WISP's body, signed over the node's origin, and answers the count and since when", async () => {
    const sfu = fakeSfu(g, () => me.pubKeyZ32);
    expect(await ask(sfu.fetch as typeof fetch)).toEqual({ ok: true, count: 2, since: 1794700500 });
    expect(sfu.seen).toHaveLength(1);
    expect(sfu.seen[0].body).toMatchObject({ v: 1, g, k: me.pubKeyZ32, room: `g_${g}` });
    expect(sfu.seen[0].body).not.toHaveProperty("name");
    expect(sfu.seen[0].init).toMatchObject({ method: "POST", redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
    expect(new Headers(sfu.seen[0].init?.headers).get("Content-Type")).toBe("application/json");
  });

  it("an empty room is a count of 0, with no since", async () => {
    expect(await ask(fakeSfu(g, () => me.pubKeyZ32, { count: 0 }).fetch as typeof fetch)).toEqual({ ok: true, count: 0 });
  });

  it("a key the node does not take is refused, once: no retry as a token request has", async () => {
    const sfu = fakeSfu(g, () => createIdentity().pubKeyZ32);
    expect(await ask(sfu.fetch as typeof fetch)).toEqual({ ok: false, code: "refused" });
    expect(sfu.seen).toHaveLength(1);
  });

  it("each status says its code: 429 with its wait, 404 and 405 an older node, the rest unreachable", async () => {
    const at = Date.parse("2026-11-15T12:00:00Z");
    const limited = (header?: string) => ask(once(async () => new Response("", { status: 429, ...(header !== undefined && { headers: { "Retry-After": header } }) })), () => at);
    expect(await limited("30")).toEqual({ ok: false, code: "rate_limited", retryAfter: 30 });
    expect(await limited("Sun, 15 Nov 2026 12:00:45 GMT")).toEqual({ ok: false, code: "rate_limited", retryAfter: 45 });
    expect(await limited()).toEqual({ ok: false, code: "rate_limited", retryAfter: 60 });
    for (const status of [404, 405]) expect(await ask(once(async () => new Response("", { status })))).toEqual({ ok: false, code: "unsupported" });
    const unreachable = { ok: false, code: "unreachable" };
    expect(await ask(once(async () => { throw new TypeError("Failed to fetch"); }))).toEqual(unreachable);
    expect(await ask(once(async () => { throw new DOMException("timed out", "TimeoutError"); }))).toEqual(unreachable);
    expect(await ask(once(async () => new Response("oops", { status: 500 })))).toEqual(unreachable);
    expect(await ask(once(async () => new Response("not json")))).toEqual(unreachable);
    expect(await ask(once(async () => Response.json({ count: -1 })))).toEqual(unreachable);
    expect(await ask(once(async () => new Response(JSON.stringify({ count: 1, since: 1 }).padEnd(64 * 1024 + 1))))).toEqual(unreachable);
  });
});

interface Inner { groups: { communities: { session(id: string): { state: { meta?: GroupMeta }; myKey: string } | undefined } } }

const nodes: GhostlyNode[] = [];
beforeEach(async () => {
  const names = Object.values(STORES) as string[];
  await transact(names as never, (s: Record<string, { clear(): void }>) => { for (const name of names) s[name].clear(); });
});
afterEach(async () => { vi.unstubAllGlobals(); for (const node of nodes.splice(0)) await node.shutdown(); });

/** A community I made, with `call` naming the node when `call` is set. */
async function community(call: Record<string, unknown> | null = { sfu: SFU }) {
  await db.putSettings({ online: true, nick: "Ana", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  const transport = { publish: vi.fn(async () => {}), resolve: vi.fn(async () => null), describe: () => ({ protocol: "in-process", relays: [] }) };
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() } as never, { transport, automaticWallets: false });
  nodes.push(node);
  await node.start();
  const { groupId } = await node.createGroup({ name: "Plaza", profile: "community" });
  const session = (node as unknown as Inner).groups.communities.session(groupId)!;
  const setCall = (value: Record<string, unknown> | null, name = "Plaza") =>
    session.state.meta = { ...(session.state.meta ?? {} as GroupMeta), body: JSON.stringify({ name, ...(value && { call: value }) }) };
  setCall(call);
  return { node, groupId, session, setCall };
}

describe("the engine's groupCallOccupancy", () => {
  it("a member asks with its member key and gets the node's count", async () => {
    const { node, groupId, session } = await community();
    const sfu = fakeSfu(groupId, () => session.myKey);
    vi.stubGlobal("fetch", sfu.fetch);
    expect(await node.groupCallOccupancy({ groupId })).toEqual({ ok: true, count: 2, since: 1794700500 });
    expect(sfu.seen.map(s => s.body.k)).toEqual([session.myKey]);
  });

  it("a group I am not in, or whose call names no node that holds, sends nothing", async () => {
    const { node, groupId, setCall } = await community(null);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await node.groupCallOccupancy({ groupId: "AAAAAAAAAAAAAAAAAAAAAA" })).toEqual({ ok: false, code: "not_member" });
    expect(await node.groupCallOccupancy({ groupId })).toEqual({ ok: false, code: "unsupported" });
    setCall({ sfu: "http://call.ghostly.test" });
    expect(await node.groupCallOccupancy({ groupId })).toEqual({ ok: false, code: "unsupported" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a node without the route is asked once, then not again until the group's call changes", async () => {
    const { node, groupId, session, setCall } = await community();
    const missing = vi.fn(async () => new Response("", { status: 404 }));
    vi.stubGlobal("fetch", missing);
    expect(await node.groupCallOccupancy({ groupId })).toEqual({ ok: false, code: "unsupported" });
    expect(await node.groupCallOccupancy({ groupId })).toEqual({ ok: false, code: "unsupported" });
    // A rename keeps the call as it was: still not asked.
    setCall({ sfu: SFU }, "Plaza Mayor");
    expect(await node.groupCallOccupancy({ groupId })).toEqual({ ok: false, code: "unsupported" });
    expect(missing).toHaveBeenCalledTimes(1);

    // The admin changes the call (here, turns sealing on): the node is asked again, and now has the route.
    setCall({ sfu: SFU, e2ee: 1 });
    const sfu = fakeSfu(groupId, () => session.myKey, { count: 0 });
    vi.stubGlobal("fetch", sfu.fetch);
    expect(await node.groupCallOccupancy({ groupId })).toEqual({ ok: true, count: 0 });
    expect(await node.groupCallOccupancy({ groupId })).toEqual({ ok: true, count: 0 });
    expect(sfu.seen).toHaveLength(2);
  });

  it("a refusal, a 429 or no answer is asked again next time", async () => {
    const { node, groupId } = await community();
    const statuses = [403, 429, 500];
    const fetch = vi.fn(async () => new Response("", { status: statuses.shift() ?? 403, headers: { "Retry-After": "20" } }));
    vi.stubGlobal("fetch", fetch);
    expect(await node.groupCallOccupancy({ groupId })).toEqual({ ok: false, code: "refused" });
    expect(await node.groupCallOccupancy({ groupId })).toEqual({ ok: false, code: "rate_limited", retryAfter: 20 });
    expect(await node.groupCallOccupancy({ groupId })).toEqual({ ok: false, code: "unreachable" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

import "fake-indexeddb/auto";
import { createPublicKey, verify as nodeVerify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, fromBase64Url, identityFromSeedB64, publicKeyFromZ32, rosterHas, toBase64Url, type GroupMeta, type Roster } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import type { Groups } from "../src/engine/groups";
import { GROUP_CALL_RETRY_MS, fetchGroupCallToken, groupCallSfu, signGroupCallRequest } from "../src/engine/groupCall";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
// covers: groups.protocol.call-token

/**
 * WISP 602 · Group Calls § The token request: the engine asks the node its group's admin named for a pass, signed with
 * the member key. The node is a fake that checks what the WISP says a node checks, and verifies the signature with
 * `node:crypto` alone, as the WISP says any implementation can.
 */

Object.defineProperty(globalThis.navigator, "storage", { value: { estimate: async () => ({ quota: 50 * 1024 ** 3, usage: 10 * 1024 ** 3 }) }, configurable: true });

const SFU = "https://call.ghostly.test";
const SPKI = Buffer.from("302a300506032b6570032100", "hex");

interface Seen { url: string; method?: string; type?: string; body: Record<string, unknown> }

/**
 * A node that forwards a group's calls: it answers members of `roster()` (WISP 602 § What the node checks) and refuses
 * anyone else with the same 403. `refuse`: that many first requests are refused anyway (it has not taken the commit yet).
 */
function fakeSfu(g: string, roster: () => Roster, { refuse = 0, now = () => Date.now() } = {}) {
  const seen: Seen[] = [], nonces = new Set<string>();
  const handler = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    seen.push({ url: String(input), method: init?.method, type: new Headers(init?.headers).get("Content-Type") ?? undefined, body });
    const forbidden = () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    if (String(input) !== `${SFU}/sfu/group-token` || init?.method !== "POST") return new Response("", { status: 404 });
    if (seen.length <= refuse) return forbidden();
    const { v, k, room, ts, n, sig } = body as { v: number; k: string; room: string; ts: number; n: string; sig: string };
    if (v !== 1 || body.g !== g || room !== `g_${g}` || Math.abs(now() / 1000 - ts) > 60 || nonces.has(n)) return forbidden();
    const signed = Buffer.from(JSON.stringify(["ghostly-sfu/1 token", SFU, g, room, k, ts, n]));
    const key = createPublicKey({ key: Buffer.concat([SPKI, publicKeyFromZ32(k)]), format: "der", type: "spki" });
    if (!nodeVerify(null, signed, key, fromBase64Url(sig)) || !rosterHas(roster(), k)) return forbidden();
    nonces.add(n);
    return Response.json({ url: "wss://sfu.ghostly.test", token: "lk-token", room, identity: k, expiresIn: 600, iceServers: [{ urls: "turn:turn.ghostly.test:3478", username: "u", credential: "c" }, { nope: 1 }] });
  });
  return { seen, fetch: handler };
}

describe("the request is the WISP's", () => {
  it("signs the test vector's bytes: the same signature", () => {
    const seed = Uint8Array.from({ length: 32 }, (_, i) => i);
    const k = identityFromSeedB64(Buffer.from(seed).toString("base64url")).pubKeyZ32;
    expect(k).toBe("yqooxx9u3aemh8mo5wcqq16yufu6jitouq1o4za751dger1igghy");
    const request = signGroupCallRequest("https://call.ghostly.tools", { g: "oKGio6SlpqeoqaqrrK2urw", k, ts: 1794700800, n: "EBESExQVFhcYGRobHB0eHw", name: "Ana" }, seed);
    expect(request).toEqual({ v: 1, g: "oKGio6SlpqeoqaqrrK2urw", k, room: "g_oKGio6SlpqeoqaqrrK2urw", ts: 1794700800, n: "EBESExQVFhcYGRobHB0eHw", name: "Ana",
      sig: "-DM_Wifuh9bawYteCmmCioMprub4RrZFss7LXyQ5TKA9ntVgcqzZkCvYUuKnL4rZ7mDdncm_7SfBBQsHhd-NCw" });
  });

  it("reads call.sfu only as an https origin in its one spelling", () => {
    const meta = (body: unknown) => ({ body: JSON.stringify(body) }) as GroupMeta;
    expect(groupCallSfu(meta({ call: { sfu: "https://call.ghostly.tools" } }))).toBe("https://call.ghostly.tools");
    expect(groupCallSfu(meta({ call: { sfu: "https://call.ghostly.tools:8443", other: 1 } }))).toBe("https://call.ghostly.tools:8443");
    for (const sfu of ["http://call.ghostly.tools", "https://call.ghostly.tools/", "https://call.ghostly.tools/x", "https://Call.ghostly.tools", "https://a@call.ghostly.tools", "https://call.ghostly.tools:443", `https://${"a".repeat(200)}.tools`, 7])
      expect(groupCallSfu(meta({ call: { sfu } })), String(sfu)).toBeUndefined();
    expect(groupCallSfu(meta({ name: "Plaza" }))).toBeUndefined();
    expect(groupCallSfu({ body: "not json" } as GroupMeta)).toBeUndefined();
    expect(groupCallSfu(undefined)).toBeUndefined();
  });
});

describe("asking the node", () => {
  const me = createIdentity(), g = "oKGio6SlpqeoqaqrrK2urw";
  const roster: Roster = [[me.pubKeyZ32, "member"]];
  const ask = (fetch: typeof globalThis.fetch, sleeps: number[] = []) =>
    fetchGroupCallToken({ sfu: SFU, g, k: me.pubKeyZ32, seed: me.seed, name: "Ana", fetch, sleep: async ms => { sleeps.push(ms); } });

  it("a 403 right after joining is asked again, fresh each time, and the third try gets the pass", async () => {
    const sfu = fakeSfu(g, () => roster, { refuse: 2 }), sleeps: number[] = [];
    const pass = await ask(sfu.fetch as typeof fetch, sleeps);
    expect(pass).toMatchObject({ token: "lk-token", room: `g_${g}`, identity: me.pubKeyZ32 });
    expect(sleeps).toEqual([...GROUP_CALL_RETRY_MS]);
    expect(sleeps.reduce((a, b) => a + b)).toBe(10_000);
    expect(new Set(sfu.seen.map(s => s.body.n)).size).toBe(3);
  });

  it("refused three times: one line that names the node", async () => {
    const sfu = fakeSfu(g, () => []);
    await expect(ask(sfu.fetch as typeof fetch)).rejects.toThrow("call.ghostly.test did not let you into the group's call. Try again in a minute.");
    expect(sfu.seen).toHaveLength(3);
  });

  it("busy, unreachable, timed out or a reply that is no pass: one line each, not asked again", async () => {
    const once = (response: () => Promise<Response>) => vi.fn(response) as unknown as typeof fetch;
    await expect(ask(once(async () => new Response("", { status: 429, headers: { "Retry-After": "30" } })))).rejects.toThrow("call.ghostly.test is busy. Try the call again in a minute.");
    await expect(ask(once(async () => { throw new TypeError("Failed to fetch"); }))).rejects.toThrow("Could not reach call.ghostly.test");
    await expect(ask(once(async () => { throw new DOMException("timed out", "TimeoutError"); }))).rejects.toThrow("call.ghostly.test did not answer in time");
    const failed = "call.ghostly.test could not start the group's call. Try again later.";
    await expect(ask(once(async () => new Response("oops", { status: 500 })))).rejects.toThrow(failed);
    await expect(ask(once(async () => new Response("not json")))).rejects.toThrow(failed);
    await expect(ask(once(async () => Response.json({ url: "wss://x", token: "t", room: "g_other", identity: me.pubKeyZ32, expiresIn: 600 })))).rejects.toThrow(failed);
    await expect(ask(once(async () => Response.json({ url: "https://x", token: "t", room: `g_${g}`, identity: me.pubKeyZ32, expiresIn: 600 })))).rejects.toThrow(failed);
  });

  it("follows no redirect and sends no cookie or referrer: a 307 would send my key and name to a host the group never named", async () => {
    const sfu = fakeSfu(g, () => roster);
    await ask(sfu.fetch as typeof fetch);
    expect(sfu.fetch.mock.calls[0][1]).toMatchObject({ redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
  });

  it("a reply past 64 KiB is read no further than that, said or not in its length", async () => {
    const failed = "call.ghostly.test could not start the group's call. Try again later.";
    const chunk = new Uint8Array(16 * 1024).fill(0x20);
    let pulled = 0, cancelled = false;
    const endless = new ReadableStream<Uint8Array>({ pull: c => { pulled++; c.enqueue(chunk); }, cancel: () => { cancelled = true; } }, { highWaterMark: 0 });
    await expect(ask(vi.fn(async () => new Response(endless)) as unknown as typeof fetch)).rejects.toThrow(failed);
    expect(pulled).toBeLessThanOrEqual(6);
    expect(cancelled).toBe(true);

    let read = false;
    const declared = new ReadableStream<Uint8Array>({ pull: c => { read = true; c.enqueue(chunk); } }, { highWaterMark: 0 });
    await expect(ask(vi.fn(async () => new Response(declared, { headers: { "Content-Length": String(128 * 1024 * 1024) } })) as unknown as typeof fetch)).rejects.toThrow(failed);
    expect(read).toBe(false);

    const pass = JSON.stringify({ url: "wss://sfu.ghostly.test", token: "t", room: `g_${g}`, identity: me.pubKeyZ32, expiresIn: 600 });
    await expect(ask(vi.fn(async () => new Response(pass.padEnd(64 * 1024))) as unknown as typeof fetch)).resolves.toMatchObject({ token: "t" });
  });

  it("a ws:// address is taken only on this machine, and only under test: LiveKit puts the pass in the address, and the node names it", async () => {
    const reply = (url: string) => vi.fn(async () => Response.json({ url, token: "t", room: `g_${g}`, identity: me.pubKeyZ32, expiresIn: 600 })) as unknown as typeof fetch;
    const askWith = (url: string, loopback: boolean) => fetchGroupCallToken({ sfu: SFU, g, k: me.pubKeyZ32, seed: me.seed, fetch: reply(url), loopback, sleep: async () => {} });
    const failed = "call.ghostly.test could not start the group's call. Try again later.";
    for (const url of ["ws://sfu.ghostly.test", "ws://192.168.1.20:7880", "ws://127.0.0.1.example.org", "ws://[::2]:7880"])
      for (const loopback of [false, true]) await expect(askWith(url, loopback), url).rejects.toThrow(failed);
    // A node's pass may not send the member's LiveKit client to a local port with a path of its own.
    for (const url of ["ws://127.0.0.1:6379/anything?x=1", "ws://localhost:631/admin/", "ws://[::1]:9222/devtools/browser/x"])
      await expect(ask(reply(url)), url).rejects.toThrow(failed);
    await expect(ask(reply("wss://sfu.ghostly.test")), "wss").resolves.toMatchObject({ url: "wss://sfu.ghostly.test" });
    for (const url of ["wss://sfu.ghostly.test", "ws://127.0.0.1:47120", "ws://localhost:7880", "ws://[::1]:7880"])
      await expect(askWith(url, true), url).resolves.toMatchObject({ url });
  });
});

interface Inner { groups: Groups & { sessions: Map<string, { state: { meta?: GroupMeta }; roster: Roster }> } }

const nodes: GhostlyNode[] = [];
beforeEach(async () => {
  const names = Object.values(STORES) as string[];
  await transact(names as never, (s: Record<string, { clear(): void }>) => { for (const name of names) s[name].clear(); });
});
afterEach(async () => { vi.unstubAllGlobals(); for (const node of nodes.splice(0)) await node.shutdown(); });

async function started(options: { groupCallFetch?: typeof fetch; groupCallLoopback?: boolean } = {}) {
  await db.putSettings({ online: true, nick: "Ana", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  const transport = { publish: vi.fn(async () => {}), resolve: vi.fn(async () => null), describe: () => ({ protocol: "in-process", relays: [] }) };
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() } as never, { transport, automaticWallets: false, ...options });
  nodes.push(node);
  await node.start();
  return { node, inner: node as unknown as Inner };
}

/** The admin's metadata with `call`, as the admin's app will sign it once it sets the field. */
const withCall = (state: { meta?: GroupMeta }) => { state.meta = { ...state.meta!, body: JSON.stringify({ call: { sfu: SFU } }) }; };

describe("the engine's groupCallToken", () => {
  for (const profile of ["community", "mesh"] as const) {
    it(`a member of a ${profile} group with call gets the node's pass; its request verifies at the node`, async () => {
      const { node, inner } = await started();
      const { groupId } = await node.createGroup({ name: "Plaza", profile });
      const session = profile === "community" ? inner.groups.communities.session(groupId)! : inner.groups.sessions.get(groupId)!;
      session.state.meta ??= { body: "{}" } as GroupMeta;
      withCall(session.state);
      const sfu = fakeSfu(groupId, () => session.roster);
      vi.stubGlobal("fetch", sfu.fetch);
      const pass = await node.groupCallToken({ groupId });
      const myKey = node.getState().groups.find(gv => gv.id === groupId)!.myKey!;
      expect(pass).toEqual({ url: "wss://sfu.ghostly.test", token: "lk-token", room: `g_${groupId}`, identity: myKey, expiresIn: 600,
        iceServers: [{ urls: ["turn:turn.ghostly.test:3478"], username: "u", credential: "c" }] });
      expect(sfu.seen).toHaveLength(1);
      expect(sfu.seen[0]).toMatchObject({ method: "POST", type: "application/json", body: { v: 1, g: groupId, k: myKey, room: `g_${groupId}`, name: "Ana" } });
    });
  }

  it("asks the node through the host's groupCallFetch (the CLI's checks the address when it connects), the pass and the moderation alike", async () => {
    const page = vi.fn();
    vi.stubGlobal("fetch", page);
    const host = vi.fn(async (input: string | URL | Request) => String(input).endsWith("/sfu/group-token") ? new Response("", { status: 429 }) : Response.json({ muted: {}, banned: [] }));
    const { node, inner } = await started({ groupCallFetch: host as unknown as typeof fetch });
    const { groupId } = await node.createGroup({ name: "Plaza", profile: "community" });
    const session = inner.groups.communities.session(groupId)!;
    session.state.meta ??= { body: "{}" } as GroupMeta;
    withCall(session.state);
    await expect(node.groupCallToken({ groupId })).rejects.toThrow("call.ghostly.test is busy");
    await node.groupCallModerate({ groupId, act: "state" });
    expect(host.mock.calls.map(([url]) => String(url))).toEqual([`${SFU}/sfu/group-token`, `${SFU}/sfu/group-moderate`]);
    expect(page).not.toHaveBeenCalled();
  });

  it("takes a pass's ws:// address on this machine only when the host says so (groupCallLoopback, the e2e build's)", async () => {
    for (const groupCallLoopback of [false, true]) {
      const reply = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const { room, k } = JSON.parse(String(init?.body)) as { room: string; k: string };
        return Response.json({ url: "ws://127.0.0.1:47120", token: "t", room, identity: k, expiresIn: 600 });
      });
      const { node, inner } = await started({ groupCallFetch: reply as unknown as typeof fetch, groupCallLoopback });
      const { groupId } = await node.createGroup({ name: "Plaza", profile: "community" });
      const session = inner.groups.communities.session(groupId)!;
      session.state.meta ??= { body: "{}" } as GroupMeta;
      withCall(session.state);
      const asked = node.groupCallToken({ groupId });
      if (groupCallLoopback) await expect(asked).resolves.toMatchObject({ url: "ws://127.0.0.1:47120" });
      else await expect(asked).rejects.toThrow("call.ghostly.test could not start the group's call");
    }
  });

  it("a group without call, or one I am not in: a plain error and nothing asked", async () => {
    const { node } = await started();
    const { groupId } = await node.createGroup({ name: "Plaza" });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(node.groupCallToken({ groupId })).rejects.toThrow("This group has no calls: its admin has not set a call server");
    await expect(node.groupCallToken({ groupId: "AAAAAAAAAAAAAAAAAAAAAA" })).rejects.toThrow("You are not in this group, so you can't join its call");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("the engine's groupCallKey (WISP 602 § End-to-end encryption)", () => {
  it("hands a community member the session's call key for the newest epoch, base64url, and the next one after the epoch moves", async () => {
    const { node, inner } = await started();
    const { groupId } = await node.createGroup({ name: "Plaza", profile: "community" });
    const session = inner.groups.communities.session(groupId)!;
    const first = node.groupCallKey({ groupId })!;
    const own = session.callKey()!;
    expect(first).toEqual({ epoch: own.epoch, key: toBase64Url(own.key) });
    expect(fromBase64Url(first.key)).toHaveLength(32);
    expect(first.epoch).toBe(node.getState().groups.find(gv => gv.id === groupId)!.epoch);

    await node.rotateGroup({ groupId });
    const next = node.groupCallKey({ groupId })!;
    expect(next.epoch).toBe(first.epoch + 1);
    expect(next.key).not.toBe(first.key);
    expect(next).toEqual({ epoch: session.callKey()!.epoch, key: toBase64Url(session.callKey()!.key) });
    // The page learns the move from the group's view, which carries the same epoch.
    expect(node.getState().groups.find(gv => gv.id === groupId)!.epoch).toBe(next.epoch);
  });

  it("is null in a private group, in a group I am not in, and for a group id that is not a string", async () => {
    const { node } = await started();
    const { groupId } = await node.createGroup({ name: "Plaza", profile: "mesh" });
    expect(node.groupCallKey({ groupId })).toBeNull();
    expect(node.groupCallKey({ groupId: "AAAAAAAAAAAAAAAAAAAAAA" })).toBeNull();
    expect(node.groupCallKey({ groupId: 7 as unknown as string })).toBeNull();
  });
});

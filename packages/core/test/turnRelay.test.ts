import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyTurnRead, RelayTransport, signTurnPacket, turnPayloadSequence, turnSequence, withRequestOptions, TURN_SOURCE_TIMEOUT_MS, type TurnSourceAnswer } from "../src/index";
import { devices, signerOf, vectorKeys } from "./turnVectors";
// covers: devices.turn.read

/*
 * The turn record's own path on the relays (WISP 06 § Publishing and reading), against relays that disagree, lag,
 * refuse and time out. Each relay here keeps one packet per key and answers a PUT the way a relay does: 409 for an
 * older or equal sequence, 412 for an `If-Match` that names another packet.
 */

const keys = vectorKeys(), all = devices(), key = keys.identity.pubKeyZ32;
const slots = all.map((device, i) => (i < 3 ? { key: device.publicKey, name: device.name } : null));
const packet = (turn: number, rev: number, author: number) => signTurnPacket(keys, { turn, rev, author, active: author, slots, instance: new Uint8Array(8).fill(rev + 1) }, signerOf(all[author]));

interface FakeRelay { held: Uint8Array | null; mode?: "down" | "hang" | "500" | "ignores-if-match" | "old" | "invalid-item"; requests: { method: string; ifMatch: string | null }[]; urls: string[] }

function relays(names: string[]) {
  const state: Record<string, FakeRelay> = Object.fromEntries(names.map((name) => [name, { held: null, requests: [], urls: [] }]));
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), relay = state[url.host];
    const headers = new Headers(init?.headers);
    relay.urls.push(url.pathname + url.search);
    // A relay from before the `policy` query refuses it; asked plainly, it answers.
    if (relay.mode === "old" && url.search) return new Response("Failed to deserialize query string", { status: 400 });
    relay.requests.push({ method: init?.method ?? "GET", ifMatch: headers.get("if-match") });
    if (relay.mode === "invalid-item") return new Response(null, { status: 404, headers: { "pkarr-invalid-signed-packet-seq": "5242895" } });
    if (relay.mode === "down") throw new TypeError("fetch failed");
    if (relay.mode === "hang") return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    if (relay.mode === "500") return new Response(null, { status: 500 });
    if ((init?.method ?? "GET") === "GET") return relay.held ? new Response(relay.held as BodyInit) : new Response(null, { status: 404 });
    const body = new Uint8Array(init!.body as Uint8Array);
    const heldSequence = relay.held ? turnPayloadSequence(relay.held)! : null;
    const ifMatch = headers.get("if-match");
    if (ifMatch !== null && relay.mode !== "ignores-if-match" && String(heldSequence) !== ifMatch) return new Response(null, { status: 412 });
    if (heldSequence !== null && turnPayloadSequence(body)! < heldSequence) return new Response(null, { status: 409 });
    relay.held = body;
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const transport = new RelayTransport({ relays: names.map((name) => `https://${name}`), fetch: fetchFn });
  return { state, transport };
}

const bySource = (answers: TurnSourceAnswer[]) => Object.fromEntries(answers.map((a) => [new URL(a.source).host, a]));

afterEach(() => { vi.useRealTimers(); });

describe("the turn record on relays", () => {
  it("a read asks every relay, also when the first one answers, and answers nothing from memory", async () => {
    const { state, transport } = relays(["a.test", "b.test", "c.test"]);
    const old = await packet(5, 1, 0), mine = await packet(5, 2, 0);
    state["a.test"].held = old;
    state["b.test"].held = mine;
    const answers = await transport.turnRead(key);
    expect(answers.map((a) => a.answered)).toEqual([true, true, true]);
    expect(bySource(answers)["a.test"].payloads).toEqual([old]);
    expect(bySource(answers)["b.test"].payloads).toEqual([mine]);
    expect(bySource(answers)["c.test"].payloads).toEqual([]);
    expect(Object.values(state).map((relay) => relay.requests.length)).toEqual([1, 1, 1]);
    // The relays disagree: the highest sequence among them is the answer.
    expect(classifyTurnRead({ keys, ownKey: all[0].publicKey, stored: mine }, answers).result).toBe("mine");
    // A second read is a second request to each: no cache, and this client's own writes are never an answer.
    state["b.test"].held = null;
    expect(bySource(await transport.turnRead(key))["b.test"].payloads).toEqual([]);
    expect(state["b.test"].requests.length).toBe(2);
  });

  it("a relay that is down, broken or silent did not answer; the others still do", async () => {
    vi.useFakeTimers();
    const { state, transport } = relays(["a.test", "b.test", "c.test", "d.test"]);
    state["a.test"].mode = "down";
    state["b.test"].mode = "hang";
    state["c.test"].mode = "500";
    const reading = transport.turnRead(key);
    await vi.advanceTimersByTimeAsync(TURN_SOURCE_TIMEOUT_MS + 1);
    const answers = bySource(await reading);
    expect([answers["a.test"].answered, answers["b.test"].answered, answers["c.test"].answered, answers["d.test"].answered]).toEqual([false, false, false, true]);
    expect(answers["c.test"].detail).toBe("HTTP 500");
    expect(classifyTurnRead({ keys, ownKey: all[0].publicKey, stored: null }, Object.values(answers))).toMatchObject({ result: "none", good: true });
    // With every relay silent the read is not good.
    state["d.test"].mode = "down";
    const again = transport.turnRead(key);
    await vi.advanceTimersByTimeAsync(TURN_SOURCE_TIMEOUT_MS + 1);
    expect(classifyTurnRead({ keys, ownKey: all[0].publicKey, stored: null }, await again)).toMatchObject({ result: "unreachable", good: false });
  });

  it("a put goes to each relay on that relay's own condition, and reports every answer", async () => {
    const { state, transport } = relays(["a.test", "b.test", "c.test"]);
    const old = await packet(5, 1, 0), mine = await packet(5, 2, 0), next = await packet(5, 3, 0);
    state["a.test"].held = old;
    state["b.test"].held = mine;
    const read = classifyTurnRead({ keys, ownKey: all[0].publicKey, stored: mine }, await transport.turnRead(key));
    expect(read.conditions).toEqual({ "https://a.test": String(turnSequence(5, 1, 0)), "https://b.test": String(turnSequence(5, 2, 0)), "https://c.test": null });
    const puts = await transport.turnPut(key, next, read.conditions);
    expect(puts.map((p) => p.outcome)).toEqual(["stored", "stored", "stored"]);
    expect(state["a.test"].requests.at(-1)).toEqual({ method: "PUT", ifMatch: String(turnSequence(5, 1, 0)) });
    expect(state["b.test"].requests.at(-1)).toEqual({ method: "PUT", ifMatch: String(turnSequence(5, 2, 0)) });
    // A relay that held no record gets no condition: there is nothing to compare with, and the read back decides.
    expect(state["c.test"].requests.at(-1)).toEqual({ method: "PUT", ifMatch: null });
    expect(Object.values(state).map((relay) => relay.held)).toEqual([next, next, next]);
  });

  it("a refused conditional put is never sent again without its condition", async () => {
    const { state, transport } = relays(["a.test", "b.test"]);
    const mine = await packet(5, 2, 0), theirs = await packet(6, 0, 1), next = await packet(5, 3, 0);
    state["a.test"].held = mine;
    state["b.test"].held = mine;
    const read = classifyTurnRead({ keys, ownKey: all[0].publicKey, stored: mine }, await transport.turnRead(key));
    // Another device took the turn on one relay after the read.
    state["a.test"].held = theirs;
    const before = state["a.test"].requests.length;
    const puts = await transport.turnPut(key, next, read.conditions);
    expect(puts).toEqual([{ source: "https://a.test", outcome: "refused", detail: "HTTP 412" }, { source: "https://b.test", outcome: "stored", detail: "HTTP 204" }]);
    // One request to the relay that refused, with its condition. The chat path would have sent a second, bare one.
    expect(state["a.test"].requests.slice(before)).toEqual([{ method: "PUT", ifMatch: String(turnSequence(5, 2, 0)) }]);
    expect(state["a.test"].held).toBe(theirs);
    // The same through the chat path's publish, to show what the turn must not do: 412, then the same bytes with no condition.
    const chat = state["a.test"].requests.length;
    await transport.publishPayload(key, next).catch(() => {});
    await transport.publishPayload(key, await packet(5, 4, 0)).catch(() => {});
    expect(state["a.test"].requests.slice(chat).filter((r) => r.method === "PUT").map((r) => r.ifMatch)).toEqual([null, String(turnSequence(5, 3, 0)), null]);
  });

  it("an older packet is refused by the relay itself (409), with or without a condition", async () => {
    const { state, transport } = relays(["a.test"]);
    const stale = await packet(5, 2, 0), newer = await packet(6, 0, 1);
    state["a.test"].held = newer;
    expect((await transport.turnPut(key, stale, { "https://a.test": null }))[0]).toMatchObject({ outcome: "refused", detail: "HTTP 409" });
    // A relay that ignores `If-Match` still refuses the lower sequence: a stale device learns it was replaced.
    state["a.test"].mode = "ignores-if-match";
    expect((await transport.turnPut(key, stale, { "https://a.test": String(turnSequence(5, 2, 0)) }))[0]).toMatchObject({ outcome: "refused", detail: "HTTP 409" });
    expect(state["a.test"].held).toBe(newer);
  });

  it("a relay that did not answer the read is not put to, and one that fails says so", async () => {
    const { state, transport } = relays(["a.test", "b.test", "c.test"]);
    state["b.test"].mode = "down";
    const mine = await packet(5, 2, 0);
    const read = classifyTurnRead({ keys, ownKey: all[0].publicKey, stored: null }, await transport.turnRead(key));
    expect(Object.keys(read.conditions)).toEqual(["https://a.test", "https://c.test"]);
    state["c.test"].mode = "500";
    const sent = state["b.test"].requests.length;
    const puts = await transport.turnPut(key, mine, read.conditions);
    expect(puts.map((p) => [new URL(p.source).host, p.outcome])).toEqual([["a.test", "stored"], ["c.test", "failed"]]);
    expect(state["b.test"].requests.length).toBe(sent);
  });

  it("the stored bytes are put unchanged: an identical packet refreshes the item", async () => {
    const { state, transport } = relays(["a.test"]);
    const mine = await packet(5, 2, 0);
    await transport.turnPut(key, mine, { "https://a.test": null });
    const again = await transport.turnPut(key, mine, { "https://a.test": String(turnSequence(5, 2, 0)) });
    expect(again[0].outcome).toBe("stored");
    expect(state["a.test"].held).toEqual(mine);
  });

  it("a read asks the relay to look on the network, not in its cache; an older relay is asked plainly", async () => {
    const { state, transport } = relays(["a.test", "b.test"]);
    const mine = await packet(5, 2, 0);
    state["a.test"].held = mine;
    state["b.test"].held = mine;
    state["b.test"].mode = "old";
    const answers = await transport.turnRead(key);
    expect(answers.map((a) => a.payloads)).toEqual([[mine], [mine]]);
    // The plain answer may be five minutes old: it is marked, and never makes `mine` alone.
    expect(answers.map((a) => a.stale)).toEqual([undefined, true]);
    expect(classifyTurnRead({ keys, ownKey: all[0].publicKey, stored: mine }, [answers[1]]).result).toBe("unreachable");
    expect(state["a.test"].urls).toEqual([`/${key}?policy=NetworkOnly`]);
    expect(state["b.test"].urls).toEqual([`/${key}?policy=NetworkOnly`, `/${key}`]);
  });

  it("a sequence a relay names for an item it does not hand over is unsigned: that relay's condition, never seen", async () => {
    const { state, transport } = relays(["a.test"]);
    state["a.test"].mode = "invalid-item";
    const answers = await transport.turnRead(key);
    expect(answers).toEqual([{ source: "https://a.test", answered: true, payloads: [], sequences: ["5242895"] }]);
    const read = classifyTurnRead({ keys, ownKey: all[0].publicKey, stored: await packet(5, 2, 0) }, answers);
    expect(read).toMatchObject({ result: "none", good: true, seen: 0n, conditions: { "https://a.test": "5242895" }, invalid: [], unsigned: [{ source: "https://a.test", sequence: 5242895n }] });
  });

  it("a transport wrapped with request options still has the turn's path", async () => {
    const { transport } = relays(["a.test"]);
    const wrapped = withRequestOptions(transport, { group: true });
    expect(await wrapped.turnRead!(key)).toEqual([{ source: "https://a.test", answered: true, payloads: [] }]);
    expect(typeof wrapped.turnPut).toBe("function");
  });
});

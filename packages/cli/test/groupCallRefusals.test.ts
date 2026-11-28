import { createPrivateKey } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo, LookupFunction } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentity, engineError, toBase64Url, type GroupMeta } from "@ghostly/core";
import { GROUP_CALL_RETRY_MS } from "@ghostly/browser/engine/groupCall";
import { GhostlyNode } from "@ghostly/browser/engine/node";
import { callApi, type ApiContext } from "../src/api";
import { EXIT, asCliError } from "../src/errors";
import { nodeGroupCallFetch } from "../src/runtime/groupCallFetch";
import { pem, testCertificate } from "../../core/test/support/x509";

// covers: groups.protocol.call-token, groups.protocol.call-moderation

// Every refusal of `engine groupCallToken` and `groupCallModerate` was `engine` (exit 1), the code a bot may retry:
// a member banned or not let in (403), a busy node (429), not a member, no call node, and an act, target or sources
// the engine does not take all looked alike without matching the English words.

/** What `ghostly engine <method> --json` prints for an error, and the exit status it leaves with. */
const said = (error: unknown) => { const e = asCliError(error); return { json: e.toJSON(), exit: EXIT[e.code] }; };

describe("asCliError says a group call's refusals by what they are", () => {
  const host = { host: "sfu.example" };
  it("a pass the node or the group does not give is `refused`; a busy node or one answering no pass `unavailable`", () => {
    expect(said(engineError("groupCallNotMember"))).toEqual({ json: { code: "refused", message: "You are not in this group, so you can't join its call" }, exit: 1 });
    expect(said(engineError("groupNoCall"))).toEqual({ json: { code: "refused", message: "This group has no calls: its admin has not set a call server" }, exit: 1 });
    expect(said(engineError("groupCallRefused", host))).toEqual({ json: { code: "refused", message: "sfu.example did not let you into the group's call. Try again in a minute." }, exit: 1 });
    expect(said(engineError("groupCallBusy", host))).toEqual({ json: { code: "unavailable", message: "sfu.example is busy. Try the call again in a minute." }, exit: 1 });
    expect(said(engineError("groupCallFailed", host))).toEqual({ json: { code: "unavailable", message: "sfu.example could not start the group's call. Try again later." }, exit: 1 });
    // Unchanged: a node not there, one too slow.
    expect(said(engineError("hostUnreachable", host)).json.code).toBe("unavailable");
    expect(said(engineError("hostTimedOut", host))).toMatchObject({ json: { code: "timeout" }, exit: 4 });
  });

  it("an act, a target or sources the moderation call does not take is `bad_request`", () => {
    for (const message of ["act must be one of mute, allow, remove, unban, state", "target must be the key of another member", "src must list one or more of camera, microphone, screen_share"])
      expect(said(new Error(message)), message).toEqual({ json: { code: "bad_request", message }, exit: 1 });
    // Only those words: one that only starts like them stays the engine's.
    expect(said(new Error("target must be the key of another member, or else")).json.code).toBe("engine");
  });
});

describe("`engine groupCallToken` and `groupCallModerate` through the engine, against a call node on this machine", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it("a node's 403 after the retries is `refused`, its 429 and a reply with no pass `unavailable`; not a member or no node `refused`", async () => {
    const leaf = testCertificate({ subject: "call.example", dns: ["call.example"] });
    const key = createPrivateKey({ key: { kty: "EC", crv: "P-256", d: toBase64Url(leaf.secret), x: toBase64Url(leaf.publicKey.slice(1, 33)), y: toBase64Url(leaf.publicKey.slice(33)) }, format: "jwk" });
    let status = 403, asked = 0;
    const server = createHttpsServer({ cert: pem(leaf), key: key.export({ type: "pkcs8", format: "pem" }) }, (request, response) => {
      request.resume();
      request.on("end", () => { asked++; response.writeHead(status, { "Content-Type": "application/json" }).end("{}"); });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    // The test's own certificate, at a name this lookup alone knows.
    vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    const lookup = ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) =>
      options.all ? callback(null, [{ address: "127.0.0.1", family: 4 }]) : callback(null, "127.0.0.1", 4)) as unknown as LookupFunction;
    // The engine's waits before asking again after a 403 (3 s, then 7 s), cut to nothing.
    const realTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) =>
      realTimeout(fn, (GROUP_CALL_RETRY_MS as readonly number[]).includes(ms ?? 0) ? 0 : ms)) as unknown as typeof setTimeout);
    const me = createIdentity(), other = createIdentity(), g = "oKGio6SlpqeoqaqrrK2urw";
    const port = (server.address() as AddressInfo).port, hostPort = `call.example:${port}`;
    let sfu: string | undefined = `https://${hostPort}`;
    // The engine's own `groupCallToken` and `groupCallModerate`, on a node whose group rows are these.
    const node = Object.create(GhostlyNode.prototype) as GhostlyNode;
    const own = (name: string, value: unknown) => Object.defineProperty(node, name, { value, writable: true });
    own("groups", { callMember: (id: string) => id !== g ? undefined : { key: me.pubKeyZ32, seedB64: toBase64Url(me.seed), meta: { body: JSON.stringify(sfu ? { call: { sfu } } : {}) } as GroupMeta, isAdmin: true, members: 2 } });
    own("options", { groupCallFetch: nodeGroupCallFetch(lookup) });
    own("settings", { nick: "Bot" });
    const ctx = { runtime: { server: { node }, paths: { name: "default" } }, mode: "daemon", version: "test" } as unknown as ApiContext;
    const engine = (method: string, params: Record<string, unknown>) => callApi(ctx, "engine.call", { method, params }).then(() => { throw new Error(`${method} answered`); }, said);
    try {
      expect(await engine("groupCallToken", { groupId: g })).toEqual({ json: { code: "refused", message: `${hostPort} did not let you into the group's call. Try again in a minute.` }, exit: 1 });
      expect(asked).toBe(1 + GROUP_CALL_RETRY_MS.length);
      status = 429;
      expect(await engine("groupCallToken", { groupId: g })).toEqual({ json: { code: "unavailable", message: `${hostPort} is busy. Try the call again in a minute.` }, exit: 1 });
      status = 200;
      expect(await engine("groupCallToken", { groupId: g })).toEqual({ json: { code: "unavailable", message: `${hostPort} could not start the group's call. Try again later.` }, exit: 1 });
      expect(asked).toBe(5);
      expect(await engine("groupCallToken", { groupId: "AAAAAAAAAAAAAAAAAAAAAA" })).toMatchObject({ json: { code: "refused" }, exit: 1 });
      sfu = undefined;
      expect(await engine("groupCallToken", { groupId: g })).toEqual({ json: { code: "refused", message: "This group has no calls: its admin has not set a call server" }, exit: 1 });
      sfu = `https://${hostPort}`;
      // The moderation call's refusals of what it was given: nothing is sent.
      for (const params of [{ act: "kick", target: other.pubKeyZ32 }, { act: "remove", target: me.pubKeyZ32 }, { act: "remove", target: "bo" }, { act: "mute", target: other.pubKeyZ32, src: ["screen_share_audio"] }])
        expect(await engine("groupCallModerate", { groupId: g, ...params }), JSON.stringify(params)).toMatchObject({ json: { code: "bad_request" }, exit: 1 });
      expect(asked).toBe(5);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }, 30_000);
});

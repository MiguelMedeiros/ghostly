import { createHmac, createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { keyBytes, moderateBytes, signedBytes, startTokenService, verifyModeration, verifyRequest } from "../../../e2e/infra/sfu-token/server.mjs";

/** WISP 602 § Test vector. */
const SEED = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const K = "yqooxx9u3aemh8mo5wcqq16yufu6jitouq1o4za751dger1igghy";
const G = "oKGio6SlpqeoqaqrrK2urw";
const TS = 1794700800;
const ORIGIN = "https://call.ghostly.tools";
const VECTOR = { v: 1, g: G, k: K, room: `g_${G}`, ts: TS, n: "EBESExQVFhcYGRobHB0eHw", sig: "-DM_Wifuh9bawYteCmmCioMprub4RrZFss7LXyQ5TKA9ntVgcqzZkCvYUuKnL4rZ7mDdncm_7SfBBQsHhd-NCw" };

const member = createPrivateKey({ key: Buffer.from(`302e020100300506032b657004220420${SEED}`, "hex"), format: "der", type: "pkcs8" });
let nonce = 0;
/** A request signed by the vector's key, a new nonce each time. */
function request(over: Record<string, unknown> = {}, origin = ORIGIN) {
  const body: Record<string, unknown> = { ...VECTOR, n: Buffer.alloc(16, ++nonce).toString("base64url"), name: "Ana", ...over };
  return { ...body, sig: sign(null, signedBytes(origin, body), member).toString("base64url"), ...("sig" in over ? { sig: over.sig } : {}) };
}

describe("the group-token mock (e2e/infra/sfu-token, WISP 602)", () => {
  it("verifies the WISP's test vector byte for byte", () => {
    expect(keyBytes(K)?.toString("hex")).toBe("03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8");
    const bytes = signedBytes(ORIGIN, VECTOR);
    expect(bytes.length).toBe(195);
    expect(bytes.toString("hex")).toBe("5b2267686f73746c792d7366752f3120746f6b656e222c2268747470733a2f2f63616c6c2e67686f73746c792e746f6f6c73222c226f4b47696f36536c7071656f71617172724b32757277222c22675f6f4b47696f36536c7071656f71617172724b32757277222c2279716f6f787839753361656d68386d6f3577637171313679756675366a69746f7571316f347a6137353164676572316967676879222c313739343730303830302c2245424553457851564668635947526f62484230654877225d");
    expect(verifyRequest(ORIGIN, VECTOR)).toBe(true);
    // Made for one node, refused at another; and a key in a spelling that is not its one canonical one.
    expect(verifyRequest("https://other.ghostly.tools", VECTOR)).toBe(false);
    expect(keyBytes(`${K.slice(0, 51)}b`)).toBeNull();
  });

  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  async function service(rosters: Record<string, Record<string, string>> = { [G]: { [K]: "Ana (roster)" } }) {
    const clock = { now: TS * 1000 };
    const s = await startTokenService({ origin: ORIGIN, livekitUrl: "ws://127.0.0.1:47120", rosters, now: () => clock.now });
    close = s.close;
    const post = (body: unknown) => fetch(`${s.url}/sfu/group-token`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
    return { ...s, clock, post };
  }

  it("gives a member of the roster a LiveKit pass for its group's room only, under its roster name", async () => {
    const { post } = await service();
    const res = await post(request());
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const reply = await res.json();
    expect(reply).toMatchObject({ url: "ws://127.0.0.1:47120", room: `g_${G}`, identity: K, expiresIn: 600 });
    const [header, payload, mac] = reply.token.split(".");
    expect(createHmac("sha256", "secret").update(`${header}.${payload}`).digest("base64url")).toBe(mac);
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({
      iss: "devkey", sub: K, name: "Ana (roster)", nbf: TS, exp: TS + 600, video: { room: `g_${G}`, roomJoin: true },
    });
  });

  it("refuses each of the five checks with the same 403", async () => {
    const { post, clock, url } = await service();
    const refused = async (body: unknown, why: string) => {
      const res = await post(body);
      expect(res.status, why).toBe(403);
      expect(await res.json(), why).toEqual({ error: "refused" });
      expect(res.headers.get("access-control-allow-origin"), why).toBe("*");
    };
    await refused("not json", "not JSON");
    await refused(JSON.stringify(request({ name: "x".repeat(4100) })), "over 4 KiB");
    await refused(request({ room: "g_AAAAAAAAAAAAAAAAAAAAAA" }), "a room other than g_ + g");
    await refused(request({ ts: TS - 61 }), "a minute and a second old");
    await refused(request({ ts: TS + 61 }), "a minute and a second ahead");
    await refused(request({}, "https://other.ghostly.tools"), "signed for another node");
    await refused(request({ sig: VECTOR.sig }), "a signature over other bytes");
    await refused(request({ g: "AAAAAAAAAAAAAAAAAAAAAA", room: "g_AAAAAAAAAAAAAAAAAAAAAA" }), "a group whose roster has not the key");
    const once = request();
    expect((await post(once)).status).toBe(200);
    await refused(once, "the same nonce again");
    // The nonce is kept 120 s: past that (and the request re-dated), it is new to the node.
    clock.now += 121_000;
    expect((await post(request({ ts: TS + 121, n: once.n }))).status).toBe(200);

    // The roster a test sets for a group (the test hook).
    expect((await fetch(`${url}/test/roster/${G}`, { method: "PUT", body: JSON.stringify({}) })).status).toBe(204);
    await refused(request({ ts: TS + 121 }), "the key taken out of the roster");
  });

  it("answers the browser's preflight, and slows down past 30 requests a minute", async () => {
    const { post, url } = await service();
    const preflight = await fetch(`${url}/sfu/group-token`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(Object.fromEntries(["access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers"].map((h) => [h, preflight.headers.get(h)])))
      .toEqual({ "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "Content-Type" });
    for (let i = 0; i < 30; i++) expect((await post(request())).status).toBe(200);
    const slow = await post(request());
    expect(slow.status).toBe(429);
    expect(Number(slow.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(slow.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("keeps an idle keep-alive socket open past Node's idle close, so a client's next request on it is not cut", { timeout: 15_000 }, async () => {
    // route.fetch keeps its sockets alive; a double that closed one after Node's 5 s (+ 1 s) could close it just as a
    // quiet call's next request went out on it, through the stack's docker-proxy: socket hang up.
    const { url } = await service();
    const socket = connect(Number(new URL(url).port), "127.0.0.1");
    let ended = false;
    socket.on("end", () => { ended = true; });
    const ask = async () => {
      const reply = once(socket, "data");
      socket.write("GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n");
      return String((await reply)[0]);
    };
    expect(await ask()).toMatch(/^HTTP\/1\.1 200 /);
    await new Promise((r) => setTimeout(r, 6_500));
    expect(ended).toBe(false);
    expect(await ask()).toMatch(/^HTTP\/1\.1 200 /);
    socket.destroy();
  });

  it("names a key the roster has no name for by the request's name, cut to 64 code points", async () => {
    const { post } = await service({ [G]: { [K]: "" } });
    const { token } = await (await post(request({ name: "😀".repeat(70) }))).json();
    expect(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).name).toBe("😀".repeat(64));
  });

  it("joins a sealed room the app's way: the app's livekit-client, its E2EE worker where the page asks for it, a raw key", async () => {
    const { url } = await service();
    const require = createRequire(import.meta.url);
    const app = JSON.parse(readFileSync(join(import.meta.dirname, "../../../package.json"), "utf8")).dependencies["livekit-client"];
    const mock = JSON.parse(readFileSync(join(import.meta.dirname, "../../../e2e/infra/sfu-token/package.json"), "utf8")).dependencies["livekit-client"];
    // The outsider must run the app's E2EE: livekit-client 2.15's worker let a frame through to the decoder while it did
    // not know yet whether its sender seals, which reads as frames decoded without the key.
    expect(mock).toBe(app);
    const page = await (await fetch(`${url}/smoke`)).text();
    const worker = page.match(/new Worker\("([^"]+)"\)/)?.[1];
    expect(worker).toBe("/livekit-client.e2ee.worker.js");
    expect(page).toContain("encryption: { keyProvider");
    expect(page).not.toMatch(/setKey\(passphrase\)/);
    const served = await fetch(`${url}${worker}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("text/javascript");
    expect(Buffer.from(await served.arrayBuffer()).equals(readFileSync(join(dirname(require.resolve("livekit-client")), "livekit-client.e2ee.worker.js")))).toBe(true);
  });
});

/** The call-moderation contract's test vector: the 602 vector's admin, and a target whose seed is the bytes 20 to 3f. */
const T = "fgsmiakbzufxbctqdkkpguemah5bhwupbx9bf1rz116jgewspzmo";
const MUTE = { v: 1, g: G, k: K, room: `g_${G}`, act: "mute", target: T, src: ["microphone"], ts: TS, n: "EBESExQVFhcYGRobHB0eHw", sig: "2peeO1AFgpOYW4cc9QUOjumCQ7DZJd21q4Gl--joR0jzBF7hqmjrNy5huAig1uhhgNEC2tz5vTi16bfVuSQ2DA" };
const targetKey = createPrivateKey({ key: Buffer.from(`302e020100300506032b657004220420${"202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f"}`, "hex"), format: "der", type: "pkcs8" });

/** A moderation request signed by `by` (the admin unless told), a new nonce each time. */
function moderation(over: Record<string, unknown> = {}, by = member) {
  const body: Record<string, unknown> = { ...MUTE, n: Buffer.alloc(16, ++nonce).toString("base64url"), ...over };
  return { ...body, sig: sign(null, moderateBytes(ORIGIN, body), by).toString("base64url") };
}
/** A token request signed by the target. */
const targetPass = (over: Record<string, unknown> = {}) => {
  const body: Record<string, unknown> = { ...VECTOR, k: T, n: Buffer.alloc(16, ++nonce).toString("base64url"), ...over };
  return { ...body, sig: sign(null, signedBytes(ORIGIN, body), targetKey).toString("base64url") };
};
const grant = (token: string) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).video;

describe("the group-token mock's moderation route (POST /sfu/group-moderate)", () => {
  it("verifies the contract's test vector byte for byte, and no token request passes for one", () => {
    expect(keyBytes(T)?.toString("hex")).toBe("29acbae141bccaf0b22e1a94d34d0bc7361e526d0bfe12c89794bc9322966dd7");
    const bytes = moderateBytes(ORIGIN, MUTE);
    expect(bytes.length).toBe(275);
    expect(bytes.toString()).toBe(`["ghostly-sfu/1 moderate","https://call.ghostly.tools","oKGio6SlpqeoqaqrrK2urw","g_oKGio6SlpqeoqaqrrK2urw","yqooxx9u3aemh8mo5wcqq16yufu6jitouq1o4za751dger1igghy","mute","fgsmiakbzufxbctqdkkpguemah5bhwupbx9bf1rz116jgewspzmo",["microphone"],1794700800,"EBESExQVFhcYGRobHB0eHw"]`);
    expect(Buffer.from(MUTE.sig, "base64url").toString("hex")).toBe("da979e3b50058293985b871cf5050e8ee98243b0d925ddb5ab81a5fbe8e84748f3045ee1aa68eb372e61b808a0d6e86180d102dadcf9bd38b5e9b7d5b924360c");
    expect(verifyModeration(ORIGIN, MUTE)).toBe(true);
    expect(verifyModeration("https://other.ghostly.tools", MUTE)).toBe(false);
    // The tags differ: a token request's signature is no moderation's, and back.
    expect(verifyModeration(ORIGIN, { ...MUTE, sig: sign(null, signedBytes(ORIGIN, MUTE), member).toString("base64url") })).toBe(false);
    expect(verifyRequest(ORIGIN, { ...VECTOR, sig: MUTE.sig })).toBe(false);
  });

  let close: (() => Promise<void>)[] = [];
  afterEach(async () => { await Promise.all(close.map((c) => c())); close = []; });

  /** The mock in front of a LiveKit RoomService stand-in that has the target in the room with a camera and a microphone. */
  async function service(rosters: Record<string, unknown> = { [G]: { members: { [K]: "Ana", [T]: "Bia" }, admin: K } }) {
    const calls: { method: string; auth: Record<string, unknown>; body: Record<string, unknown> }[] = [];
    const livekit = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const method = req.url!.replace("/twirp/livekit.RoomService/", "");
        const body = JSON.parse(Buffer.concat(chunks).toString());
        calls.push({ method, auth: JSON.parse(Buffer.from(req.headers.authorization!.split(".")[1], "base64url").toString()), body });
        const here = body.identity === T;
        res.writeHead(here ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify(!here ? { code: "not_found", msg: "participant not found" }
          : method === "GetParticipant" ? { identity: T, tracks: [{ sid: "TR_cam", source: "CAMERA" }, { sid: "TR_mic", source: "MICROPHONE" }] } : {}));
      });
    });
    await new Promise<void>((done) => livekit.listen(0, "127.0.0.1", done));
    close.push(() => new Promise((done) => livekit.close(() => done())));
    const clock = { now: TS * 1000 };
    const s = await startTokenService({ origin: ORIGIN, livekitUrl: "ws://127.0.0.1:47120", livekitApi: `http://127.0.0.1:${(livekit.address() as { port: number }).port}`, rosters, now: () => clock.now });
    close.push(s.close);
    const post = (route: string, body: unknown) => fetch(`${s.url}/sfu/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const moderate = async (body: unknown) => { const res = await post("group-moderate", body); return { status: res.status, body: await res.json() }; };
    return { ...s, calls, moderate, pass: (body: unknown) => post("group-token", body) };
  }

  it("mutes, allows, removes and unbans as the roster's admin, on LiveKit and in the target's next pass", async () => {
    const { moderate, pass, calls } = await service();
    expect(grant((await (await pass(targetPass())).json()).token)).not.toHaveProperty("canPublishSources");

    expect(await moderate(MUTE)).toEqual({ status: 200, body: { state: { muted: { [T]: ["microphone"] }, banned: [] } } });
    expect(calls.map((c) => [c.method, c.body])).toEqual([
      ["GetParticipant", { room: `g_${G}`, identity: T }],
      ["MutePublishedTrack", { room: `g_${G}`, identity: T, track_sid: "TR_mic", muted: true }],
      ["UpdateParticipant", { room: `g_${G}`, identity: T, permission: { can_subscribe: true, can_publish: true, can_publish_data: true, can_publish_sources: ["CAMERA", "SCREEN_SHARE", "SCREEN_SHARE_AUDIO"] } }],
    ]);
    expect(calls[0].auth).toMatchObject({ iss: "devkey", video: { room: `g_${G}`, roomAdmin: true } });
    expect(grant((await (await pass(targetPass())).json()).token)).toMatchObject({ canPublish: true, canPublishSources: ["camera", "screen_share", "screen_share_audio"] });

    // Muted of every source, a pass publishes nothing (an empty list would be every source to LiveKit).
    await moderate(moderation({ src: ["camera", "screen_share"] }));
    expect(calls.at(-1)!.body.permission).toMatchObject({ can_publish: false, can_publish_sources: [] });
    expect(grant((await (await pass(targetPass())).json()).token)).toMatchObject({ canPublish: false });
    expect(grant((await (await pass(targetPass())).json()).token)).not.toHaveProperty("canPublishSources");

    // Allow gives the sources back and mutes or unmutes no track.
    calls.length = 0;
    expect(await moderate(moderation({ act: "allow", src: ["camera", "microphone", "screen_share"] }))).toEqual({ status: 200, body: { state: { muted: {}, banned: [] } } });
    expect(calls.map((c) => c.method)).toEqual(["GetParticipant", "UpdateParticipant"]);
    expect(calls[1].body.permission).toMatchObject({ can_publish: true, can_publish_sources: [] });

    calls.length = 0;
    expect(await moderate(moderation({ act: "remove", src: [] }))).toEqual({ status: 200, body: { state: { muted: {}, banned: [T] } } });
    expect(calls.map((c) => [c.method, c.body])).toEqual([["RemoveParticipant", { room: `g_${G}`, identity: T }]]);
    expect((await pass(targetPass())).status).toBe(403);
    expect(await moderate(moderation({ act: "state", target: "", src: [] }))).toEqual({ status: 200, body: { state: { muted: {}, banned: [T] } } });
    expect(await moderate(moderation({ act: "unban", src: [] }))).toEqual({ status: 200, body: { state: { muted: {}, banned: [] } } });
    expect(calls).toHaveLength(1);
    expect((await pass(targetPass())).status).toBe(200);
  });

  it("refuses with the token route's 403 all but the admin's well-formed request, and acts on a key not in the room", async () => {
    const { moderate, url, calls } = await service();
    const refused = async (body: unknown, why: string) => expect(await moderate(body), why).toEqual({ status: 403, body: { error: "refused" } });
    await refused(moderation({}, targetKey), "signed by a key that is not the admin");
    await refused(moderation({ k: T, target: K }, targetKey), "a member that is not the admin");
    await refused(moderation({ target: K }), "the admin as its own target");
    await refused(moderation({ src: ["microphone", "camera"] }), "sources out of order");
    await refused(moderation({ src: ["microphone", "microphone"] }), "a source twice");
    await refused(moderation({ src: [] }), "a mute of nothing");
    await refused(moderation({ act: "remove" }), "sources on a removal");
    await refused(moderation({ act: "ban", src: [] }), "an act the contract has not");
    await refused(moderation({ act: "state", src: [] }), "a target on a state read");
    await refused(moderation({ ts: TS - 61 }), "a minute and a second old");
    await refused({ ...VECTOR, act: "mute", target: T, src: ["microphone"] }, "a token request");
    const once = moderation();
    expect((await moderate(once)).status).toBe(200);
    await refused(once, "the same nonce again");
    expect(calls).toHaveLength(3);

    // A key LiveKit has not in the room: kept muted all the same, for its next pass.
    const away = "y".repeat(52);
    expect(await moderate(moderation({ target: away }))).toEqual({ status: 200, body: { state: { muted: { [T]: ["microphone"], [away]: ["microphone"] }, banned: [] } } });

    // The older roster body (key → name) has no admin: every moderation is refused.
    expect((await fetch(`${url}/test/roster/${G}`, { method: "PUT", body: JSON.stringify({ [K]: "Ana", [T]: "Bia" }) })).status).toBe(204);
    await refused(moderation(), "a roster with no admin");
    expect((await fetch(`${url}/test/roster/${G}`, { method: "PUT", body: "[]" })).status).toBe(400);
    const preflight = await fetch(`${url}/sfu/group-moderate`, { method: "OPTIONS" });
    expect([preflight.status, preflight.headers.get("access-control-allow-origin"), preflight.headers.get("access-control-allow-methods")]).toEqual([204, "*", "POST, OPTIONS"]);
  });

  it("slows down past 30 moderation requests a minute, apart from the passes", async () => {
    const { url, pass } = await service();
    const state = () => fetch(`${url}/sfu/group-moderate`, { method: "POST", body: JSON.stringify(moderation({ act: "state", target: "", src: [] })) });
    for (let i = 0; i < 30; i++) expect((await state()).status).toBe(200);
    const slow = await state();
    expect([slow.status, slow.headers.get("access-control-allow-origin")]).toEqual([429, "*"]);
    expect(Number(slow.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await pass(targetPass())).status).toBe(200);
  });
});

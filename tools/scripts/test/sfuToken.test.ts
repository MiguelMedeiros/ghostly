import { createHmac, createPrivateKey, sign } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { keyBytes, signedBytes, startTokenService, verifyRequest } from "../../../e2e/infra/sfu-token/server.mjs";

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

  it("names a key the roster has no name for by the request's name, cut to 64 code points", async () => {
    const { post } = await service({ [G]: { [K]: "" } });
    const { token } = await (await post(request({ name: "😀".repeat(70) }))).json();
    expect(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).name).toBe("😀".repeat(64));
  });
});

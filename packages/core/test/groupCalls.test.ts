import { describe, expect, it } from "vitest";
import { fromBase64Url, utf8Decode } from "../src/bytes";
import { identityFromSeed, publicKeyFromZ32 } from "../src/identity";
import {
  GROUP_CALL_NONCE_S, GROUP_CALL_SKEW_S, GROUP_CALL_SOURCES, MAX_GROUP_CALL_NAME, groupCallModerationBytes, groupCallOccupancyBytes, groupCallRequestBytes,
  groupCallRoom, parseGroupCallOccupancy, signGroupCallModeration, signGroupCallOccupancy, signGroupCallRequest, verifyGroupCallModeration,
  verifyGroupCallOccupancy, verifyGroupCallRequest, type GroupCallNonces,
} from "../src/groupCalls";

// WISP 602 § Test vector, byte for byte.
const SEED = Uint8Array.from({ length: 32 }, (_, i) => i);
const K = "yqooxx9u3aemh8mo5wcqq16yufu6jitouq1o4za751dger1igghy";
const SFU = "https://call.ghostly.tools";
const G = "oKGio6SlpqeoqaqrrK2urw";
const ROOM = "g_oKGio6SlpqeoqaqrrK2urw";
const TS = 1794700800;
const N = "EBESExQVFhcYGRobHB0eHw";
const BYTES_HEX = "5b2267686f73746c792d7366752f3120746f6b656e222c2268747470733a2f2f63616c6c2e67686f73746c792e746f6f6c73222c226f4b47696f36536c7071656f71617172724b32757277222c22675f6f4b47696f36536c7071656f71617172724b32757277222c2279716f6f787839753361656d68386d6f3577637171313679756675366a69746f7571316f347a6137353164676572316967676879222c313739343730303830302c2245424553457851564668635947526f62484230654877225d";
const SIG = "-DM_Wifuh9bawYteCmmCioMprub4RrZFss7LXyQ5TKA9ntVgcqzZkCvYUuKnL4rZ7mDdncm_7SfBBQsHhd-NCw";
const NOW = TS * 1000;

const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
const vector = () => signGroupCallRequest({ sfu: SFU, g: G, ts: TS, n: N }, SEED);

describe("group call token request (WISP 602)", () => {
  it("signs the test vector byte for byte", () => {
    expect(identityFromSeed(SEED).pubKeyZ32).toBe(K);
    expect(groupCallRoom(G)).toBe(ROOM);
    expect(hex(groupCallRequestBytes(SFU, G, ROOM, K, TS, N))).toBe(BYTES_HEX);
    expect(vector()).toEqual({ v: 1, g: G, k: K, room: ROOM, ts: TS, n: N, sig: SIG });
  });

  it("takes the test vector, then refuses it again as replayed", () => {
    const seen: GroupCallNonces = new Map();
    expect(verifyGroupCallRequest(vector(), SFU, NOW, seen)).toEqual({ ok: true, request: vector() });
    expect(verifyGroupCallRequest(vector(), SFU, NOW + 1000, seen)).toEqual({ ok: false, reason: "replayed" });
  });

  it("refuses a request whose signed fields changed", () => {
    const other = signGroupCallRequest({ sfu: SFU, g: "AAAAAAAAAAAAAAAAAAAAAA", ts: TS, n: N }, SEED);
    const changed = [
      { ...vector(), g: other.g, room: other.room },
      { ...vector(), ts: TS + 1 },
      { ...vector(), n: "EBESExQVFhcYGRobHB0eHA" },
      { ...vector(), k: identityFromSeed(new Uint8Array(32).fill(7)).pubKeyZ32 },
      { ...vector(), sig: other.sig },
    ];
    for (const request of changed) expect(verifyGroupCallRequest(request, SFU, NOW, new Map())).toEqual({ ok: false, reason: "signature" });
  });

  it("refuses a request made for another node's origin", () => {
    expect(verifyGroupCallRequest(vector(), "https://other.example", NOW, new Map())).toEqual({ ok: false, reason: "signature" });
    expect(verifyGroupCallRequest(vector(), `${SFU}/`, NOW, new Map())).toEqual({ ok: false, reason: "signature" });
  });

  it("takes a time within 60 s either way and refuses one past it", () => {
    for (const skew of [-GROUP_CALL_SKEW_S, GROUP_CALL_SKEW_S]) expect(verifyGroupCallRequest(vector(), SFU, NOW + skew * 1000, new Map()).ok).toBe(true);
    for (const skew of [-GROUP_CALL_SKEW_S - 1, GROUP_CALL_SKEW_S + 1]) expect(verifyGroupCallRequest(vector(), SFU, NOW + skew * 1000, new Map())).toEqual({ ok: false, reason: "stale" });
  });

  it("keeps a nonce 120 s, then lets it go", () => {
    const seen: GroupCallNonces = new Map([[N, TS - GROUP_CALL_NONCE_S]]);
    expect(verifyGroupCallRequest(vector(), SFU, NOW, seen)).toEqual({ ok: false, reason: "replayed" });
    seen.set(N, TS - GROUP_CALL_NONCE_S - 1);
    expect(verifyGroupCallRequest(vector(), SFU, NOW, seen).ok).toBe(true);
    expect(seen.get(N)).toBe(TS);
  });

  it("does not spend a nonce on a request that fails its signature", () => {
    const seen: GroupCallNonces = new Map();
    expect(verifyGroupCallRequest({ ...vector(), ts: TS + 1 }, SFU, NOW, seen).ok).toBe(false);
    expect(seen.size).toBe(0);
  });

  it("refuses a request out of shape before it checks anything else", () => {
    const bad: unknown[] = [
      null, "x", [], { ...vector(), v: 2 }, { ...vector(), room: `g_${G}x` }, { ...vector(), room: G }, { ...vector(), g: "short" },
      { ...vector(), k: K.toUpperCase() }, { ...vector(), ts: 1.5 }, { ...vector(), ts: String(TS) }, { ...vector(), n: N + "A" },
      { ...vector(), n: "EBESExQVFhcYGRobHB0eHx" }, { ...vector(), name: 7 }, { ...vector(), sig: SIG.slice(1) },
    ];
    for (const request of bad) expect(verifyGroupCallRequest(request, SFU, NOW, new Map())).toEqual({ ok: false, reason: "malformed" });
  });

  it("carries the name outside the signature, clean and at most 64 code points", () => {
    const named = signGroupCallRequest({ sfu: SFU, g: G, ts: TS, n: N, name: " Ana‮ " }, SEED);
    expect(named.name).toBe("Ana");
    expect(named.sig).toBe(SIG);
    const long = { ...vector(), name: "😀".repeat(MAX_GROUP_CALL_NAME + 5) };
    const result = verifyGroupCallRequest(long, SFU, NOW, new Map());
    expect(result.ok && [...(result.request.name ?? "")].length).toBe(MAX_GROUP_CALL_NAME);
    const blank = verifyGroupCallRequest({ ...vector(), name: "​" }, SFU, NOW, new Map());
    expect(blank.ok && "name" in blank.request).toBe(false);
  });

  it("makes a fresh 16-byte nonce and the current time when none is given", () => {
    const a = signGroupCallRequest({ sfu: SFU, g: G }, SEED), b = signGroupCallRequest({ sfu: SFU, g: G }, SEED);
    expect(a.n).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a.n).not.toBe(b.n);
    expect(Math.abs(a.ts - Date.now() / 1000)).toBeLessThan(5);
    expect(verifyGroupCallRequest(a, SFU, Date.now(), new Map()).ok).toBe(true);
  });
});

// WISP 602 § Moderation's test vector: the token vector's seed and inputs, a target whose seed is the bytes 0x20 to 0x3f.
const TARGET_SEED = Uint8Array.from({ length: 32 }, (_, i) => 0x20 + i);
const TARGET = "fgsmiakbzufxbctqdkkpguemah5bhwupbx9bf1rz116jgewspzmo";
const MODERATE_TEXT = `["ghostly-sfu/1 moderate","https://call.ghostly.tools","oKGio6SlpqeoqaqrrK2urw","g_oKGio6SlpqeoqaqrrK2urw","${K}","mute","${TARGET}",["microphone"],1794700800,"EBESExQVFhcYGRobHB0eHw"]`;
const MODERATE_SIG = "2peeO1AFgpOYW4cc9QUOjumCQ7DZJd21q4Gl--joR0jzBF7hqmjrNy5huAig1uhhgNEC2tz5vTi16bfVuSQ2DA";
const MODERATE_SIG_HEX = "da979e3b50058293985b871cf5050e8ee98243b0d925ddb5ab81a5fbe8e84748f3045ee1aa68eb372e61b808a0d6e86180d102dadcf9bd38b5e9b7d5b924360c";

const mute = () => signGroupCallModeration({ sfu: SFU, g: G, act: "mute", target: TARGET, src: ["microphone"], ts: TS, n: N }, SEED);

describe("group call moderation request (WISP 602 § Moderation)", () => {
  it("signs the test vector byte for byte", () => {
    expect(identityFromSeed(TARGET_SEED).pubKeyZ32).toBe(TARGET);
    expect(hex(publicKeyFromZ32(TARGET))).toBe("29acbae141bccaf0b22e1a94d34d0bc7361e526d0bfe12c89794bc9322966dd7");
    const bytes = groupCallModerationBytes(SFU, G, ROOM, K, "mute", TARGET, ["microphone"], TS, N);
    expect(bytes).toHaveLength(275);
    expect(utf8Decode(bytes)).toBe(MODERATE_TEXT);
    expect(mute()).toEqual({ v: 1, g: G, k: K, room: ROOM, act: "mute", target: TARGET, src: ["microphone"], ts: TS, n: N, sig: MODERATE_SIG });
    expect(hex(Buffer.from(MODERATE_SIG, "base64url"))).toBe(MODERATE_SIG_HEX);
  });

  it("takes the test vector, then refuses it again as replayed", () => {
    const seen: GroupCallNonces = new Map();
    expect(verifyGroupCallModeration(mute(), SFU, NOW, seen)).toEqual({ ok: true, request: mute() });
    expect(verifyGroupCallModeration(mute(), SFU, NOW + 1000, seen)).toEqual({ ok: false, reason: "replayed" });
  });

  it("takes every act in its own shape", () => {
    const requests = [
      signGroupCallModeration({ sfu: SFU, g: G, act: "allow", target: TARGET, src: ["screen_share", "camera", "camera"], ts: TS, n: N }, SEED),
      signGroupCallModeration({ sfu: SFU, g: G, act: "remove", target: TARGET, ts: TS, n: N }, SEED),
      signGroupCallModeration({ sfu: SFU, g: G, act: "unban", target: TARGET, ts: TS, n: N }, SEED),
      signGroupCallModeration({ sfu: SFU, g: G, act: "state", ts: TS, n: N }, SEED),
    ];
    expect(requests[0].src).toEqual(["camera", "screen_share"]);
    expect(requests[3]).toMatchObject({ target: "", src: [] });
    for (const request of requests) expect(verifyGroupCallModeration(request, SFU, NOW, new Map())).toEqual({ ok: true, request });
  });

  it("knows the microphone, the camera and the screen share only", () => {
    expect(GROUP_CALL_SOURCES).toEqual(["camera", "microphone", "screen_share"]);
  });

  it("refuses a wrong tag: a token request's signature, or a moderation one offered as a token request", () => {
    const token = signGroupCallRequest({ sfu: SFU, g: G, ts: TS, n: N }, SEED);
    const state = signGroupCallModeration({ sfu: SFU, g: G, act: "state", ts: TS, n: N }, SEED);
    expect(verifyGroupCallModeration({ ...state, sig: token.sig }, SFU, NOW, new Map())).toEqual({ ok: false, reason: "signature" });
    expect(verifyGroupCallRequest({ ...token, sig: state.sig }, SFU, NOW, new Map())).toEqual({ ok: false, reason: "signature" });
  });

  it("refuses a request whose signed fields changed, or made for another node", () => {
    const changed = [
      { ...mute(), act: "allow" }, { ...mute(), src: ["camera"] }, { ...mute(), target: identityFromSeed(new Uint8Array(32).fill(7)).pubKeyZ32 },
      { ...mute(), ts: TS + 1 }, { ...mute(), n: "EBESExQVFhcYGRobHB0eHA" },
    ];
    for (const request of changed) expect(verifyGroupCallModeration(request, SFU, NOW, new Map())).toEqual({ ok: false, reason: "signature" });
    expect(verifyGroupCallModeration(mute(), "https://other.example", NOW, new Map())).toEqual({ ok: false, reason: "signature" });
  });

  it("refuses a stale time and keeps no nonce of a refused request", () => {
    for (const skew of [-GROUP_CALL_SKEW_S - 1, GROUP_CALL_SKEW_S + 1]) expect(verifyGroupCallModeration(mute(), SFU, NOW + skew * 1000, new Map())).toEqual({ ok: false, reason: "stale" });
    const seen: GroupCallNonces = new Map();
    expect(verifyGroupCallModeration({ ...mute(), ts: TS + 1 }, SFU, NOW, seen).ok).toBe(false);
    expect(seen.size).toBe(0);
  });

  it("refuses a request out of shape, even signed as it stands", () => {
    const bad = [
      signGroupCallModeration({ sfu: SFU, g: G, act: "mute", target: K, src: ["microphone"], ts: TS, n: N }, SEED),
      signGroupCallModeration({ sfu: SFU, g: G, act: "mute", target: TARGET, src: [], ts: TS, n: N }, SEED),
      signGroupCallModeration({ sfu: SFU, g: G, act: "remove", target: "", ts: TS, n: N }, SEED),
    ];
    for (const request of bad) expect(verifyGroupCallModeration(request, SFU, NOW, new Map())).toEqual({ ok: false, reason: "malformed" });
    const shapes: unknown[] = [
      null, [], { ...mute(), v: 2 }, { ...mute(), act: "kick" }, { ...mute(), room: G }, { ...mute(), target: TARGET.toUpperCase() },
      { ...mute(), src: ["microphone", "camera"] }, { ...mute(), src: ["camera", "camera"] }, { ...mute(), src: ["screen_share_audio"] },
      { ...mute(), src: "microphone" }, { ...mute(), act: "remove", src: ["microphone"] }, { ...mute(), act: "unban", src: ["camera"] },
      { ...mute(), act: "state" }, { ...mute(), act: "state", target: "", src: ["camera"] }, { ...mute(), ts: 1.5 }, { ...mute(), sig: MODERATE_SIG.slice(1) },
    ];
    for (const request of shapes) expect(verifyGroupCallModeration(request, SFU, NOW, new Map())).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses a name or any other field the WISP does not list, signed as it stands, and one missing a field", () => {
    const shapes: unknown[] = [
      { ...mute(), name: "Ana" }, { ...mute(), why: "x".repeat(2000) }, { ...mute(), sig2: MODERATE_SIG },
      (({ src: _src, ...rest }) => rest)(signGroupCallModeration({ sfu: SFU, g: G, act: "state", ts: TS, n: N }, SEED)),
    ];
    for (const request of shapes) expect(verifyGroupCallModeration(request, SFU, NOW, new Map())).toEqual({ ok: false, reason: "malformed" });
  });

  it("takes the WISP's vector as written there, and every act as the app's builder sends it over the wire", () => {
    const vector = { v: 1, g: G, k: K, room: ROOM, act: "mute", target: TARGET, src: ["microphone"], ts: TS, n: N, sig: MODERATE_SIG };
    expect(verifyGroupCallModeration(vector, SFU, NOW, new Map())).toEqual({ ok: true, request: vector });
    // The builder (unchanged since the route shipped in 1.13.0) is what the app posts as JSON.
    const acts = [
      { act: "mute", target: TARGET, src: ["camera", "microphone", "screen_share"] }, { act: "allow", target: TARGET, src: ["microphone"] },
      { act: "remove", target: TARGET }, { act: "unban", target: TARGET }, { act: "state" },
    ] as const;
    for (const ask of acts) {
      const wire = JSON.parse(JSON.stringify(signGroupCallModeration({ sfu: SFU, g: G, ts: TS, n: N, ...ask }, SEED)));
      expect(Object.keys(wire).sort()).toEqual(["act", "g", "k", "n", "room", "sig", "src", "target", "ts", "v"]);
      expect(verifyGroupCallModeration(wire, SFU, NOW, new Map())).toEqual({ ok: true, request: wire });
    }
  });
});

// WISP 602 § Occupancy's test vector: the token request's key and inputs, under the occupancy tag.
const OCCUPANCY_HEX = "5b2267686f73746c792d7366752f31206f63637570616e6379222c2268747470733a2f2f63616c6c2e67686f73746c792e746f6f6c73222c226f4b47696f36536c7071656f71617172724b32757277222c22675f6f4b47696f36536c7071656f71617172724b32757277222c2279716f6f787839753361656d68386d6f3577637171313679756675366a69746f7571316f347a6137353164676572316967676879222c313739343730303830302c2245424553457851564668635947526f62484230654877225d";
const OCCUPANCY_SIG = "hlyYqmKssxvlNpMEQIUUd5k2arVEyIVBKbwYL3L7CfLgvZYFlZy0ZfwA8DAujkC-rhmsG0oxTSJQBRNEfJl1CQ";
const OCCUPANCY_SIG_HEX = "865c98aa62acb31be53693044085147799366ab544c8854129bc182f72fb09f2e0bd9605959cb465fc00f0302e8e40beae19ac1b4a314d22500513447c997509";

const occupancy = () => signGroupCallOccupancy({ sfu: SFU, g: G, ts: TS, n: N }, SEED);

describe("group call occupancy request (WISP 602 § Occupancy)", () => {
  it("signs the test vector byte for byte", () => {
    const bytes = groupCallOccupancyBytes(SFU, G, ROOM, K, TS, N);
    expect(bytes).toHaveLength(199);
    expect(utf8Decode(bytes)).toBe(`["ghostly-sfu/1 occupancy","https://call.ghostly.tools","oKGio6SlpqeoqaqrrK2urw","g_oKGio6SlpqeoqaqrrK2urw","${K}",1794700800,"EBESExQVFhcYGRobHB0eHw"]`);
    expect(hex(bytes)).toBe(OCCUPANCY_HEX);
    expect(occupancy()).toEqual({ v: 1, g: G, k: K, room: ROOM, ts: TS, n: N, sig: OCCUPANCY_SIG });
    expect(hex(Buffer.from(OCCUPANCY_SIG, "base64url"))).toBe(OCCUPANCY_SIG_HEX);
  });

  it("draws a new 16-byte nonce for each request, so the node never takes the next ask for a replay", () => {
    const a = signGroupCallOccupancy({ sfu: SFU, g: G }, SEED), b = signGroupCallOccupancy({ sfu: SFU, g: G }, SEED);
    expect(a.n).not.toBe(b.n);
    for (const { n } of [a, b]) {
      expect(n).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(fromBase64Url(n)).toHaveLength(16);
    }
  });

  it("takes the test vector, then refuses it again as replayed", () => {
    const seen: GroupCallNonces = new Map();
    expect(verifyGroupCallOccupancy(occupancy(), SFU, NOW, seen)).toEqual({ ok: true, request: occupancy() });
    expect(verifyGroupCallOccupancy(occupancy(), SFU, NOW + 1000, seen)).toEqual({ ok: false, reason: "replayed" });
  });

  it("is none of the other two requests, and neither of them is one", () => {
    const token = signGroupCallRequest({ sfu: SFU, g: G, ts: TS, n: N }, SEED);
    const state = signGroupCallModeration({ sfu: SFU, g: G, act: "state", ts: TS, n: N }, SEED);
    expect(verifyGroupCallOccupancy(token, SFU, NOW, new Map())).toEqual({ ok: false, reason: "signature" });
    expect(verifyGroupCallRequest(occupancy(), SFU, NOW, new Map())).toEqual({ ok: false, reason: "signature" });
    expect(verifyGroupCallModeration({ ...state, sig: occupancy().sig }, SFU, NOW, new Map())).toEqual({ ok: false, reason: "signature" });
  });

  it("refuses a request whose signed fields changed, or made for another node", () => {
    const changed = [{ ...occupancy(), ts: TS + 1 }, { ...occupancy(), n: "EBESExQVFhcYGRobHB0eHA" }, { ...occupancy(), k: identityFromSeed(new Uint8Array(32).fill(7)).pubKeyZ32 }];
    for (const request of changed) expect(verifyGroupCallOccupancy(request, SFU, NOW, new Map())).toEqual({ ok: false, reason: "signature" });
    expect(verifyGroupCallOccupancy(occupancy(), "https://other.example", NOW, new Map())).toEqual({ ok: false, reason: "signature" });
  });

  it("refuses a stale time and keeps no nonce of a refused request", () => {
    for (const skew of [-GROUP_CALL_SKEW_S, GROUP_CALL_SKEW_S]) expect(verifyGroupCallOccupancy(occupancy(), SFU, NOW + skew * 1000, new Map()).ok).toBe(true);
    for (const skew of [-GROUP_CALL_SKEW_S - 1, GROUP_CALL_SKEW_S + 1]) expect(verifyGroupCallOccupancy(occupancy(), SFU, NOW + skew * 1000, new Map())).toEqual({ ok: false, reason: "stale" });
    const seen: GroupCallNonces = new Map();
    expect(verifyGroupCallOccupancy({ ...occupancy(), ts: TS + 1 }, SFU, NOW, seen).ok).toBe(false);
    expect(seen.size).toBe(0);
  });

  it("refuses a request out of shape, a name or any other field among them", () => {
    const shapes: unknown[] = [
      null, [], { ...occupancy(), v: 2 }, { ...occupancy(), room: G }, { ...occupancy(), g: "short" }, { ...occupancy(), k: K.toUpperCase() },
      { ...occupancy(), ts: 1.5 }, { ...occupancy(), n: N + "A" }, { ...occupancy(), sig: OCCUPANCY_SIG.slice(1) },
      { ...occupancy(), name: "Ana" }, { ...occupancy(), extra: 1 }, (({ n: _n, ...rest }) => rest)(occupancy()),
    ];
    for (const request of shapes) expect(verifyGroupCallOccupancy(request, SFU, NOW, new Map())).toEqual({ ok: false, reason: "malformed" });
  });

  it("reads the node's reply: a count of 0 or more, and since only while someone is in", () => {
    expect(parseGroupCallOccupancy({ count: 3, since: 1794700500 })).toEqual({ count: 3, since: 1794700500 });
    expect(parseGroupCallOccupancy({ count: 0 })).toEqual({ count: 0 });
    expect(parseGroupCallOccupancy({ count: 0, since: 1794700500 })).toEqual({ count: 0 });
    expect(parseGroupCallOccupancy({ count: 2 })).toEqual({ count: 2 });
    expect(parseGroupCallOccupancy({ count: 2, since: "1794700500" })).toEqual({ count: 2 });
    for (const raw of [null, [], {}, { count: -1 }, { count: 1.5 }, { count: "3" }, { count: Number.MAX_SAFE_INTEGER + 1 }])
      expect(parseGroupCallOccupancy(raw), JSON.stringify(raw)).toBeNull();
  });
});

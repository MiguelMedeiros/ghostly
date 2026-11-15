import { describe, expect, it } from "vitest";
import { identityFromSeed } from "../src/identity";
import {
  GROUP_CALL_NONCE_S, GROUP_CALL_SKEW_S, MAX_GROUP_CALL_NAME, groupCallRequestBytes, groupCallRoom, signGroupCallRequest, verifyGroupCallRequest, type GroupCallNonces,
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

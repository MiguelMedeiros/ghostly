import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIdentity, encodeSvcbPacket, signRelayPayload, type Identity } from "@ghostly/core";
import { AuthToken, Keypair, Pubky, PublicKey, type Signer } from "@synonymdev/pubky";
import { setBrowserHost, type BrowserHost, type PubkyCookieSession } from "../src/host";
import { withPubkyApproval } from "../src/proofs/pubky";
import type { ApprovalRequest } from "../src/proofs/contract";
// covers: proofs.pubky

/**
 * A Pubky Ring approval (the cookie request of proofs/pubky.ts) end to end with the real Pubky SDK, against Pubky in
 * memory: Pkarr relays, the HTTP relay the approval travels through, and a homeserver whose session is a cookie.
 * The page's fetch here is the desktop app's WKWebView: it drops the homeserver's `Set-Cookie` and so never sends the
 * cookie back. Without the host's cookie session the homeserver refuses the write (and Ghostly says why); with it,
 * the session's requests go through the host, which keeps the cookie, and the proof is written.
 */

const HOMESERVER = "hs.example.com";
const RELAY = "https://httprelay.pubky.app";
const PKARR_RELAYS = ["https://pkarr.pubky.org", "https://pkarr.pubky.app"];
const FOLDER = `/pub/ghostly.app/proofs/${"c0".repeat(32)}`;
const CAPABILITY = `${FOLDER}/:w` as const;

type Answer = { status: number; headers: [string, string][]; body: Uint8Array };
type Call = { url: URL; method: string; headers: Headers; body: Uint8Array };

/** LEB128, as postcard writes integers. */
const varint = (n: bigint) => {
  const out: number[] = [];
  do { let byte = Number(n & 0x7fn); n >>= 7n; if (n) byte |= 0x80; out.push(byte); } while (n);
  return out;
};

/** The homeserver's answer to a session request, as pubky-testnet 0.12 serializes it (postcard SessionInfo). */
function sessionInfo(publicKey: Uint8Array, capabilities: string[]): Uint8Array {
  const bytes = [0, ...publicKey, ...varint(BigInt(Date.now()) * 1000n), 0, 0, ...varint(BigInt(capabilities.length))];
  for (const capability of capabilities) {
    const text = new TextEncoder().encode(capability);
    bytes.push(...varint(BigInt(text.length)), ...text);
  }
  return Uint8Array.from(bytes);
}

class PubkyInMemory {
  readonly relays = new Map(PKARR_RELAYS.map(r => [r, new Map<string, Uint8Array>()]));
  readonly inbox = new Map<string, Uint8Array>();
  /** Cookie → owner: the sessions the homeserver gave out. */
  readonly sessions = new Map<string, string>();
  readonly files = new Map<string, string>();
  /** The homeserver's requests, and whether each came with a session cookie. */
  readonly homeserverCalls: { method: string; path: string; cookie: boolean; via: "page" | "host" }[] = [];
  readonly hs: Identity = createIdentity();

  /** `pathAddressed`: the homeserver says (`/info`) it addresses storage by path, `/storage/<key>/pub/…`, as 0.12 does. */
  constructor(private pathAddressed = true) {
    const payload = signRelayPayload(this.hs, encodeSvcbPacket([
      { name: this.hs.pubKeyZ32, priority: 1, target: "", port: 6287 },
      { name: this.hs.pubKeyZ32, priority: 10, target: HOMESERVER },
    ]), BigInt(Date.now()) * 1000n);
    for (const relay of this.relays.values()) relay.set(this.hs.pubKeyZ32, payload);
  }

  /** The homeserver: a session is a cookie, set by `POST /session` and needed by everything after it. */
  homeserver(call: Call, cookie: string | undefined, via: "page" | "host"): Answer {
    const owner = cookie && this.sessions.get(cookie);
    this.homeserverCalls.push({ method: call.method, path: call.url.pathname, cookie: !!owner, via });
    const text = (status: number, body = "") => ({ status, headers: [["content-type", "text/plain"]] as [string, string][], body: new TextEncoder().encode(body) });
    if (call.url.pathname === "/info")
      return { status: 200, headers: [["content-type", "application/json"]], body: new TextEncoder().encode(JSON.stringify({ features: this.pathAddressed ? ["path-addressed-storage"] : [] })) };
    if (call.url.pathname === "/session" && call.method === "POST") {
      const token = AuthToken.verify(call.body);
      const key = token.publicKey;
      try {
        if (key.z32() !== call.headers.get("pubky-host")) return text(400, "pubky-host is not the token's key");
        const secret = crypto.randomUUID();
        this.sessions.set(secret, key.z32());
        return {
          status: 200,
          headers: [["content-type", "application/octet-stream"], ["set-cookie", `${key.z32()}=${secret}; HttpOnly; Secure; SameSite=None; Path=/`]],
          body: sessionInfo(key.toUint8Array(), token.capabilities),
        };
      } finally { key.free(); token.free(); }
    }
    if (!owner) return text(401, "No session");
    if (call.url.pathname === "/session" && call.method === "DELETE") {
      this.sessions.delete(cookie!);
      return { status: 200, headers: [["set-cookie", `${owner}=; Max-Age=0; Path=/`]], body: new Uint8Array() };
    }
    // `/storage/<key>/pub/…`, or `/pub/…` for the key in `pubky-host`.
    const file = /^\/storage\/([a-z0-9]{52})(\/pub\/.*)$/.exec(call.url.pathname) ?? /^()(\/pub\/.*)$/.exec(call.url.pathname);
    if (file && !file[1]) file[1] = call.headers.get("pubky-host") ?? "";
    if (!file || file[1] !== owner || !file[2].startsWith(`${FOLDER}/`)) return text(403, "Not yours");
    if (call.method === "PUT") { this.files.set(`${owner}${file[2]}`, new TextDecoder().decode(call.body)); return text(201); }
    if (call.method === "DELETE") { this.files.delete(`${owner}${file[2]}`); return text(204); }
    return text(405);
  }

  /** Everything else Pubky's clients reach: the Pkarr relays and the HTTP relay. */
  async other(call: Call): Promise<Answer> {
    const empty = (status: number) => ({ status, headers: [] as [string, string][], body: new Uint8Array() });
    const relay = this.relays.get(call.url.origin);
    if (relay) {
      const key = call.url.pathname.slice(1);
      if (call.method === "PUT") { for (const r of this.relays.values()) r.set(key, call.body); return empty(204); }
      const payload = relay.get(key);
      return payload ? { status: 200, headers: [["content-type", "application/pkarr.org/relays#payload"]], body: payload } : empty(404);
    }
    if (call.url.origin === RELAY) {
      const channel = call.url.pathname;
      if (call.method === "GET") {
        // The relay holds a poll until a message comes (25 s there, a moment here), then answers 408.
        for (let waited = 0; !this.inbox.has(channel) && waited < 200; waited += 10) await new Promise(r => setTimeout(r, 10));
        const message = this.inbox.get(channel);
        return message ? { status: 200, headers: [], body: message } : empty(408);
      }
      if (call.method === "DELETE") { this.inbox.delete(channel); return empty(200); }
      this.inbox.set(channel, call.body);
      return empty(200);
    }
    throw new TypeError(`Failed to fetch ${call.url.origin}`);
  }

  /** The page's fetch, as WKWebView does it: the homeserver's cookie is dropped, so none is ever sent back. */
  readonly pageFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call = await callOf(new Request(input, init));
    const answer = call.url.host === HOMESERVER ? this.homeserver(call, undefined, "page") : await this.other(call);
    return response(call.url, { ...answer, headers: answer.headers.filter(([name]) => name !== "set-cookie") });
  };

  /** The desktop app's cookie session, as Rust keeps it: one jar per approval, the page never sees a Set-Cookie. */
  readonly opened: { closed: boolean }[] = [];
  readonly hostSession = (): PubkyCookieSession => {
    const jar = new Map<string, string>();
    const state = { closed: false };
    this.opened.push(state);
    return {
      fetch: async request => {
        if (state.closed) throw new Error("closed");
        const url = new URL(request.url);
        expect(url.host).toBe(HOMESERVER);
        const answer = this.homeserver({ url, method: request.method, headers: new Headers(request.headers), body: request.body ?? new Uint8Array() },
          [...jar.values()][0], "host");
        for (const [name, value] of answer.headers) {
          if (name !== "set-cookie") continue;
          const [pair] = value.split(";");
          const [cookieName, cookie] = pair.split("=");
          if (cookie && !/Max-Age=0/.test(value)) jar.set(cookieName, cookie); else jar.delete(cookieName);
        }
        return { ...answer, headers: answer.headers.filter(([name]) => name !== "set-cookie") };
      },
      close: () => { state.closed = true; },
    };
  };
}

async function callOf(request: Request): Promise<Call> {
  return { url: new URL(request.url), method: request.method, headers: request.headers, body: new Uint8Array(await request.arrayBuffer()) };
}
/** A fetch's answer: it has its URL, which the SDK parses. */
function response(url: URL, answer: Answer): Response {
  const r = new Response([204, 205, 304].includes(answer.status) ? null : answer.body as BodyInit, { status: answer.status, headers: answer.headers });
  Object.defineProperty(r, "url", { value: url.href });
  return r;
}

/** Pubky Ring in the test: a key whose records name the in-memory homeserver, approving what it scans. */
async function ring(): Promise<{ signer: Signer; key: string }> {
  const signer = new Pubky().signer(Keypair.random());
  // The SDK takes the key over (moves it): it is not freed here.
  await signer.pkdns.publishHomeserverForce(PublicKey.from(net.hs.pubKeyZ32));
  const publicKey = signer.publicKey;
  const key = publicKey.z32();
  publicKey.free();
  return { signer, key };
}

/** Starts an approval and has Ring approve the QR code's request; resolves with what `work` returned. */
async function approveWithRing(signer: Signer, work: Parameters<typeof withPubkyApproval>[1]) {
  let shown: ApprovalRequest | undefined;
  const run = withPubkyApproval({ capability: CAPABILITY, signal: new AbortController().signal, onProgress: () => {}, onApproval: r => { shown ??= r ?? undefined; } }, work);
  await expect.poll(() => shown).toBeDefined();
  await signer.approveAuthRequest(shown!.qr!.value);
  return run;
}

let net: PubkyInMemory;
const original = globalThis.fetch;

describe("Pubky Ring's cookie session", () => {
  beforeEach(() => {
    net = new PubkyInMemory();
    globalThis.fetch = net.pageFetch as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = original;
    setBrowserHost({ version: "test" } as BrowserHost);
  });

  it.each([
    ["by path (/storage/<key>/pub/…)", true],
    ["by pubky-host (/pub/…)", false],
  ])("in the desktop app: writes the proof through the host, which keeps the cookie the WebView drops; storage addressed %s", { timeout: 30_000 }, async (_, pathAddressed) => {
    net = new PubkyInMemory(pathAddressed);
    globalThis.fetch = net.pageFetch as typeof fetch;
    setBrowserHost({ version: "test", pubkyCookieSession: net.hostSession } as unknown as BrowserHost);
    const { signer, key } = await ring();
    try {
      const wrote = await approveWithRing(signer, async s => {
        expect(s.key).toBe(key);
        await s.put(`${FOLDER}/statement.txt`, "the statement");
        return "written";
      });
      expect(wrote).toBe("written");
    } finally { signer.free(); }

    expect(net.files.get(`${key}${FOLDER}/statement.txt`)).toBe("the statement");
    // Every homeserver request of the session went through the host, with the cookie after the session began.
    const session = net.homeserverCalls.filter(c => c.path !== "/info");
    const file = pathAddressed ? `/storage/${key}${FOLDER}/statement.txt` : `${FOLDER}/statement.txt`;
    expect(session.map(c => `${c.via} ${c.method} ${c.path} ${c.cookie}`))
      .toEqual(["host POST /session false", `host PUT ${file} true`, "host DELETE /session true"]);
    expect(net.sessions.size).toBe(0);
    // Once the last poll settled, the host's session was closed and the page's fetch is the page's again.
    await expect.poll(() => net.opened.map(o => o.closed)).toEqual([true]);
    expect(globalThis.fetch).toBe(net.pageFetch);
  });

  it("in a browser that drops the cookie: nothing is written, and Ghostly says the cookie was blocked", { timeout: 30_000 }, async () => {
    setBrowserHost({ version: "test" } as BrowserHost);
    const { signer, key } = await ring();
    try {
      await expect(approveWithRing(signer, s => s.put(`${FOLDER}/statement.txt`, "the statement")))
        .rejects.toThrow(/^Pubky Ring approved, but this browser blocked the sign-in cookie of your homeserver/);
    } finally { signer.free(); }
    expect(net.files.size).toBe(0);
    expect(net.homeserverCalls.filter(c => c.path !== "/info").map(c => `${c.via} ${c.method} ${c.path === "/session" ? c.path : "file"} ${c.cookie}`))
      .toEqual(["page POST /session false", "page PUT file false", "page DELETE /session false"]);
    expect(key).toMatch(/^[a-z0-9]{52}$/);
  });
});

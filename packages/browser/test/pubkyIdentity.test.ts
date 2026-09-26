import { describe, expect, it } from "vitest";
import {
  createIdentity, encodeSvcbPacket, IdentityCheckUnavailable, identityStatement, newIdentityBinding, pubkyProofPath, signRelayPayload,
  type Identity, type IdentityStatement,
} from "@ghostly/core";
import { createPubkyIdentityProvider, type PubkyEvidence } from "../src/proofs/providers/pubky";
import { pubkyRecords } from "../src/proofs/pubky";
import { boundedIdentityFetch, verifyIdentity } from "../src/proofs/verify";
import type { IdentityFetch, VerifyContext } from "../src/proofs/contract";
import { describeIdentityProof } from "./helpers/identityProofContract";
import { answerDoh, queryFromUrl, type Zone } from "./helpers/dohZone";
// covers: proofs.pubky

/**
 * A Pubky network in memory, behind the engine's real bounded fetch: Pkarr relays holding signed packets (a key's
 * `_pubky` record, its homeserver's HTTPS record), homeservers serving `/pub/…` by the `pubky-host` header, and the
 * DNS-over-HTTPS resolvers, which give each homeserver's name a public address unless a test says otherwise.
 */
class PubkyNet {
  readonly relays = new Map<string, Map<string, Uint8Array>>([["https://pkarr.pubky.org", new Map()], ["https://pkarr.pubky.app", new Map()]]);
  /** Files by `<host>|<owner><path>`. */
  readonly files = new Map<string, string>();
  readonly requests: { url: string; headers: Record<string, string> }[] = [];
  down = new Set<string>();
  readonly zone: Zone & { a: Record<string, string[]> } = { a: {} };
  /** Status codes homeservers answer with, by host, instead of serving files. */
  readonly status = new Map<string, number>();

  publish(identity: Identity, records: Parameters<typeof encodeSvcbPacket>[0], { relays = [...this.relays.keys()], at }: { relays?: string[]; at?: bigint } = {}) {
    const payload = signRelayPayload(identity, encodeSvcbPacket(records), at ?? BigInt(Date.now()) * 1000n);
    for (const relay of relays) this.relays.get(relay)!.set(identity.pubKeyZ32, payload);
  }
  homeserver(host = "hs.example.com", port?: number): Identity {
    const hs = createIdentity();
    this.publish(hs, [{ name: hs.pubKeyZ32, priority: 1, target: "", port: 6287 }, { name: hs.pubKeyZ32, priority: 10, target: host, port }]);
    this.zone.a[host] ??= ["93.184.215.14"];
    return hs;
  }
  user(homeserver: Identity, options?: { relays?: string[]; at?: bigint }): Identity {
    const user = createIdentity();
    this.moveTo(user, homeserver, options);
    return user;
  }
  moveTo(user: Identity, homeserver: Identity, options?: { relays?: string[]; at?: bigint }) {
    this.publish(user, [{ name: `_pubky.${user.pubKeyZ32}`, priority: 0, target: homeserver.pubKeyZ32 }], options);
  }
  write(host: string, owner: string, path: string, text: string) { this.files.set(`${host}|${owner}${path}`, text); }

  readonly fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    this.requests.push({ url: url.href, headers });
    if (this.down.has(url.origin)) throw new TypeError("Failed to fetch");
    if (["https://dns.quad9.net", "https://cloudflare-dns.com", "https://dns.google"].includes(url.origin) && url.pathname === "/dns-query")
      return new Response(answerDoh(queryFromUrl(url.href), this.zone) as BodyInit, { headers: { "content-type": "application/dns-message" } });
    const status = this.status.get(url.host);
    if (status) return new Response("no", { status });
    const relay = this.relays.get(url.origin);
    if (relay) {
      const payload = relay.get(url.pathname.slice(1));
      return payload ? new Response(payload as BodyInit) : new Response(null, { status: 404 });
    }
    const owner = headers["pubky-host"];
    const text = owner === undefined ? undefined : this.files.get(`${url.host}|${owner}${url.pathname}`);
    return text === undefined ? new Response("Not found", { status: 404 }) : new Response(text, { headers: { "content-type": "text/plain" } });
  };
  readonly fetch: IdentityFetch = boundedIdentityFetch({ online: () => true, fetcher: this.fetcher });
}

const statementFor = (subject: string): IdentityStatement =>
  identityStatement(newIdentityBinding({ provider: "pubky", subject, validitySeconds: 90 * 86_400 }).binding);
const folder = "f".repeat(64);
const ctxOf = (net: PubkyNet): VerifyContext => ({ now: Math.floor(Date.now() / 1000), signal: new AbortController().signal, fetch: net.fetch });

describeIdentityProof("Pubky", async () => {
  const net = new PubkyNet();
  const hs = net.homeserver();
  const me = net.user(hs), other = net.user(hs);
  const provider = createPubkyIdentityProvider();
  const prove = (owner: Identity) => async (s: IdentityStatement): Promise<PubkyEvidence> => {
    net.write("hs.example.com", owner.pubKeyZ32, pubkyProofPath(folder, s.id), s.text);
    return { folder };
  };
  // Another key wrote the same statement to the same folder of its own storage: it proves nothing about mine.
  return { provider, subject: me.pubKeyZ32, fetch: net.fetch, prove: prove(me), proveAsOther: prove(other), revoke: () => { net.files.clear(); } };
});

describe("Pubky proofs: verify", () => {
  const provider = createPubkyIdentityProvider();
  const verify = (net: PubkyNet, s: IdentityStatement, evidence: unknown) => verifyIdentity([provider], s, evidence, ctxOf(net));

  it("reads the file from the homeserver the key's records name, addressed by pubky-host, and says how", async () => {
    const net = new PubkyNet();
    const hs = net.homeserver("homeserver.example.org", 443);
    const me = net.user(hs);
    const s = statementFor(me.pubKeyZ32);
    net.write("homeserver.example.org", me.pubKeyZ32, pubkyProofPath(folder, s.id), s.text);
    const verified = await verify(net, s, { folder });
    expect(verified).toMatchObject({ subject: me.pubKeyZ32 });
    expect(verified.source).toContain("homeserver.example.org");
    const file = net.requests.find(r => r.url.includes("/pub/ghostly.app/proofs/"))!;
    expect(file.url).toBe(`https://homeserver.example.org${pubkyProofPath(folder, s.id)}`);
    expect(file.headers["pubky-host"]).toBe(me.pubKeyZ32);
    // Both relays were asked for both keys, the resolver for the homeserver's addresses; nothing else was contacted.
    expect(net.requests.filter(r => r.url.startsWith("https://pkarr.")).map(r => new URL(r.url).pathname.slice(1)).sort())
      .toEqual([hs.pubKeyZ32, hs.pubKeyZ32, me.pubKeyZ32, me.pubKeyZ32].sort());
    expect(net.requests.filter(r => r.url.startsWith("https://dns.quad9.net/dns-query?"))).toHaveLength(2);
    expect(net.requests).toHaveLength(7);
  });

  it("contacts the homeserver only on port 443", async () => {
    const net = new PubkyNet();
    const me = net.user(net.homeserver("jenkins.corp.example.com", 8443));
    const s = statementFor(me.pubKeyZ32);
    net.write("jenkins.corp.example.com:8443", me.pubKeyZ32, pubkyProofPath(folder, s.id), s.text);
    const failure = await verify(net, s, { folder }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(IdentityCheckUnavailable);
    expect(String(failure)).toMatch(/port 8443; only port 443/);
    expect(net.requests.filter(r => !r.url.startsWith("https://pkarr."))).toEqual([]);
  });

  it("asks the next resolver when the chosen one cannot be reached (Quad9 from WebKit), the way homeserver.pubky.app is published", async () => {
    const net = new PubkyNet();
    // homeserver.pubky.app's own packet: its Pubky TLS endpoint (target ".", port 6287), then its ICANN name, no port.
    const hs = net.homeserver("homeserver.pubky.app");
    const me = net.user(hs);
    const s = statementFor(me.pubKeyZ32);
    net.write("homeserver.pubky.app", me.pubKeyZ32, pubkyProofPath(folder, s.id), s.text);
    // Quad9's HTTP/3 answers carry no Access-Control-Allow-Origin: in the Mac desktop app every fetch of it fails.
    net.down.add("https://dns.quad9.net");
    expect(await verify(net, s, { folder })).toMatchObject({ subject: me.pubKeyZ32 });
    const lookups = net.requests.filter(r => r.url.includes("/dns-query?")).map(r => new URL(r.url).host);
    expect(lookups.sort()).toEqual(["cloudflare-dns.com", "cloudflare-dns.com", "dns.quad9.net", "dns.quad9.net"]);
    // No resolver answers at all: this side's network, not the proof.
    net.down.add("https://cloudflare-dns.com").add("https://dns.google");
    const failure = await verify(net, s, { folder }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(IdentityCheckUnavailable);
    expect(String(failure)).toMatch(/Quad9 could not be reached/);
  });

  it("does not contact a homeserver name that resolves to a private network, or to nothing", async () => {
    for (const [host, addresses] of [["10-0-0-5.nip.io", ["10.0.0.5"]], ["hs.corp.example.com", ["93.184.215.14", "192.168.1.20"]], ["gone.example.com", []]] as const) {
      const net = new PubkyNet();
      net.zone.a[host] = [...addresses];
      const me = net.user(net.homeserver(host));
      const s = statementFor(me.pubKeyZ32);
      net.write(host, me.pubKeyZ32, pubkyProofPath(folder, s.id), s.text);
      const failure = await verify(net, s, { folder }).catch((e: unknown) => e);
      expect(failure, host).toBeInstanceOf(IdentityCheckUnavailable);
      expect(String(failure), host).toMatch(addresses.length ? /private network address, so it was not contacted/ : /has no address/);
      expect(net.requests.filter(r => new URL(r.url).host === host), host).toEqual([]);
    }
  });

  it("marks what this side's network did as its own: an unreachable or failing homeserver", async () => {
    const net = new PubkyNet();
    const me = net.user(net.homeserver("hs.example.com"));
    const s = statementFor(me.pubKeyZ32);
    net.status.set("hs.example.com", 503);
    await expect(verify(net, s, { folder })).rejects.toThrow(IdentityCheckUnavailable);
    await expect(verify(net, s, { folder })).rejects.toThrow(/answered 503/);
    net.status.clear();
    net.down.add("https://hs.example.com");
    await expect(verify(net, s, { folder })).rejects.toThrow(IdentityCheckUnavailable);
    // The owner's own doing is not: a missing or wrong file says what is wrong.
    net.down.clear();
    const missing = await verify(net, s, { folder }).catch((e: unknown) => e);
    expect(missing).not.toBeInstanceOf(IdentityCheckUnavailable);
    expect(String(missing)).toMatch(/not on the homeserver/);
  });

  it("refuses a file that is not exactly the statement", async () => {
    const net = new PubkyNet();
    const me = net.user(net.homeserver());
    const s = statementFor(me.pubKeyZ32);
    for (const text of [`${s.text}\n`, s.text.replace("pubky:", "pubky: "), statementFor(me.pubKeyZ32).text, ""]) {
      net.write("hs.example.com", me.pubKeyZ32, pubkyProofPath(folder, s.id), text);
      await expect(verify(net, s, { folder })).rejects.toThrow(/not this proof/);
    }
  });

  it("bounds what it reads: a large file is refused unread", async () => {
    const net = new PubkyNet();
    const me = net.user(net.homeserver());
    const s = statementFor(me.pubKeyZ32);
    net.write("hs.example.com", me.pubKeyZ32, pubkyProofPath(folder, s.id), s.text + " ".repeat(2048));
    await expect(verify(net, s, { folder })).rejects.toThrow(/too large/);
  });

  it("takes no host from the evidence: only the folder, strictly", async () => {
    const net = new PubkyNet();
    const me = net.user(net.homeserver());
    const s = statementFor(me.pubKeyZ32);
    for (const evidence of [{ folder, host: "evil.example.com" }, { folder: folder.toUpperCase() }, { folder: "../x" }, { folder: `${folder}/..` }, {}])
      await expect(verify(net, s, evidence), JSON.stringify(evidence)).rejects.toThrow(/not Pubky proof evidence/);
  });

  it("follows the key when it moves homeserver: the newest record wins, across relays", async () => {
    const net = new PubkyNet();
    const [oldHs, newHs] = [net.homeserver("old.example.com"), net.homeserver("new.example.com")];
    const me = net.user(oldHs, { at: 1_000n });
    const s = statementFor(me.pubKeyZ32);
    net.write("old.example.com", me.pubKeyZ32, pubkyProofPath(folder, s.id), s.text);
    await expect(verify(net, s, { folder })).resolves.toMatchObject({ subject: me.pubKeyZ32 });
    // Only one relay has heard of the move yet: its newer record wins; the file is not at the new homeserver.
    net.moveTo(me, newHs, { relays: ["https://pkarr.pubky.app"], at: 2_000n });
    await expect(verify(net, s, { folder })).rejects.toThrow(/not on the homeserver/);
    net.write("new.example.com", me.pubKeyZ32, pubkyProofPath(folder, s.id), s.text);
    await expect(verify(net, s, { folder })).resolves.toMatchObject({ source: expect.stringContaining("new.example.com") });
  });

  it("works with one relay down, not with none; ignores a packet another key signed", async () => {
    const net = new PubkyNet();
    const me = net.user(net.homeserver());
    const s = statementFor(me.pubKeyZ32);
    net.write("hs.example.com", me.pubKeyZ32, pubkyProofPath(folder, s.id), s.text);
    net.down.add("https://pkarr.pubky.org");
    await expect(verify(net, s, { folder })).resolves.toBeTruthy();
    // The other relay now serves a packet for my key that someone else signed.
    net.relays.get("https://pkarr.pubky.app")!.set(me.pubKeyZ32, signRelayPayload(createIdentity(), encodeSvcbPacket([{ name: "_pubky", priority: 0, target: createIdentity().pubKeyZ32 }]), 1n));
    await expect(verify(net, s, { folder })).rejects.toThrow(/no records/);
  });

  it("refuses a homeserver that only publishes a private or Pkarr address", async () => {
    for (const target of ["localhost", "hs.internal", "192.168.1.10", createIdentity().pubKeyZ32]) {
      const net = new PubkyNet();
      const hs = createIdentity();
      net.publish(hs, [{ name: hs.pubKeyZ32, priority: 10, target }]);
      const me = net.user(hs);
      await expect(verify(net, statementFor(me.pubKeyZ32), { folder }), target).rejects.toThrow(/no address a browser can reach/);
    }
  });

  it("refuses a key with no homeserver, and a subject that is not a Pubky key", async () => {
    const net = new PubkyNet();
    const me = createIdentity();
    net.publish(me, [{ name: `_other.${me.pubKeyZ32}`, priority: 0, target: createIdentity().pubKeyZ32 }]);
    await expect(verify(net, statementFor(me.pubKeyZ32), { folder })).rejects.toThrow(/names no homeserver/);
    await expect(provider.verify(statementFor("npub1notapubkykey"), { folder }, ctxOf(net))).rejects.toThrow(/not a Pubky key/);
  });

  it("reads relay answers bounded: an oversized one does not count", async () => {
    const net = new PubkyNet();
    const me = createIdentity();
    for (const relay of net.relays.values()) relay.set(me.pubKeyZ32, new Uint8Array(4096));
    await expect(pubkyRecords(me.pubKeyZ32, net.fetch)).rejects.toThrow(/too large/);
    // One relay's oversized answer is ignored when another has a valid packet.
    const hs = net.homeserver();
    net.moveTo(me, hs, { relays: ["https://pkarr.pubky.app"] });
    await expect(pubkyRecords(me.pubKeyZ32, net.fetch)).resolves.toBeInstanceOf(Uint8Array);
  });
});

describe("Pubky proofs: offline", () => {
  it("says it is offline rather than that the key has no records", async () => {
    const offline = boundedIdentityFetch({ online: () => false });
    await expect(pubkyRecords(createIdentity().pubKeyZ32, offline)).rejects.toThrow(/Offline/);
  });
});

describe("Pubky proofs: the public URI", () => {
  it("is the key as a pubky:// URI, for the profile's DID to list", () => {
    const key = createIdentity().pubKeyZ32;
    expect(createPubkyIdentityProvider().publicUri!(key)).toBe(`pubky://${key}`);
  });
});

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { atprotoCidFor, encodeDagCbor, type AtprotoCid, type CborValue } from "@ghostly/core";
import type { IdentityFetch } from "../../src/proofs/contract";
import { answerDoh, queryFromUrl, type Zone } from "./dohZone";

/**
 * A small AT Protocol network in memory, for unit tests: a PLC directory, PDSes whose repositories sign
 * real commits (secp256k1, low-S) over a one-node Merkle Search Tree, the DNS-over-HTTPS resolver, and
 * handles' `/.well-known/atproto-did`. `fetch` is what the contract's `ctx.fetch` would return; `asked`
 * lists every URL, for asserting where a check went.
 */
export interface TestAccount {
  did: string;
  handle: string;
  pds: string;
  secret: Uint8Array;
  records: Map<string, CborValue>;
  /** The DID document as the directory serves it (tests may change it). */
  doc: Record<string, unknown>;
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const randomDid = () => `did:plc:${Array.from(crypto.getRandomValues(new Uint8Array(24)), b => B32[b % 32]).join("")}`;
const multikey = (secret: Uint8Array) => `z${base58.encode(new Uint8Array([0xe7, 0x01, ...secp256k1.getPublicKey(secret, true)]))}`;

function varint(n: number): number[] {
  const out: number[] = [];
  do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n);
  return out;
}

/** A CAR proving `collection/rkey` in `account`'s repository (or its absence). */
export function recordProofCar(account: TestAccount, collection: string, rkey: string, { signWith = account.secret }: { signWith?: Uint8Array } = {}): Uint8Array {
  const enc = new TextEncoder();
  const keys = [...account.records.keys()].sort();
  const blocks: { cid: AtprotoCid; data: Uint8Array }[] = [];
  let previous = new Uint8Array(0);
  const entries: CborValue[] = [];
  for (const key of keys) {
    const data = encodeDagCbor(account.records.get(key)!);
    const cid = atprotoCidFor(data);
    const bytes = enc.encode(key);
    let p = 0;
    while (p < previous.length && p < bytes.length && previous[p] === bytes[p]) p++;
    entries.push({ k: bytes.slice(p), p, t: null, v: cid });
    previous = bytes;
    if (key === `${collection}/${rkey}`) blocks.push({ cid, data });
  }
  const node = encodeDagCbor({ e: entries, l: null });
  const nodeCid = atprotoCidFor(node);
  const unsigned = { data: nodeCid, did: account.did, prev: null, rev: "3mwd6g5tinw2f", version: 3 };
  const sig = secp256k1.sign(sha256(encodeDagCbor(unsigned)), signWith, { prehash: false, lowS: true, format: "compact" });
  const commit = encodeDagCbor({ ...unsigned, sig });
  const commitCid = atprotoCidFor(commit);
  const header = encodeDagCbor({ roots: [commitCid], version: 1 });
  const parts = [...varint(header.length), ...header];
  for (const b of [{ cid: commitCid, data: commit }, { cid: nodeCid, data: node }, ...blocks]) parts.push(...varint(b.cid.bytes.length + b.data.length), ...b.cid.bytes, ...b.data);
  return new Uint8Array(parts);
}

export function testAtprotoNetwork(options: { plc?: string } = {}) {
  const plc = options.plc ?? "https://plc.directory";
  const accounts = new Map<string, TestAccount>();
  const zone: Zone = { txt: {}, a: {}, ttl: 0 };
  const wellKnown = new Map<string, string>();
  const asked: string[] = [];

  const account = (name: string, { pds = "https://pds.example.com", handle = `${name}.example.com`, dns = true } = {}): TestAccount => {
    const secret = secp256k1.utils.randomSecretKey();
    const did = randomDid();
    const doc = {
      "@context": ["https://www.w3.org/ns/did/v1"], id: did, alsoKnownAs: [`at://${handle}`],
      verificationMethod: [{ id: `${did}#atproto`, type: "Multikey", controller: did, publicKeyMultibase: multikey(secret) }],
      service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: pds }],
    };
    const a: TestAccount = { did, handle, pds, secret, records: new Map(), doc };
    accounts.set(did, a);
    zone.a![handle] = ["203.0.113.9"];
    if (dns) zone.txt![`_atproto.${handle}`] = [`did=${did}`];
    else wellKnown.set(handle, did);
    return a;
  };

  const reply = (status: number, body: string | Uint8Array, contentType = "application/json") => {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    return { status, contentType, text: typeof body === "string" ? body : "", bytes };
  };

  const fetch: IdentityFetch = async (url, init) => {
    asked.push(url);
    if (init?.redirect === "follow") throw new Error("AT Protocol checks must never follow redirects");
    if (url.startsWith("https://dns.quad9.net/dns-query?")) return reply(200, answerDoh(queryFromUrl(url), zone), "application/dns-message");
    if (url.startsWith(`${plc}/`)) {
      const a = accounts.get(decodeURIComponent(url.slice(plc.length + 1)));
      return a ? reply(200, JSON.stringify(a.doc), "application/did+ld+json") : reply(404, JSON.stringify({ message: "DID not registered" }));
    }
    const u = new URL(url);
    if (u.pathname === "/.well-known/atproto-did") {
      const did = wellKnown.get(u.hostname);
      return did ? reply(200, did, "text/plain") : reply(404, "not found", "text/plain");
    }
    if (u.pathname === "/.well-known/did.json") {
      const a = accounts.get(`did:web:${u.hostname}`);
      return a ? reply(200, JSON.stringify(a.doc)) : reply(404, "");
    }
    if (u.pathname === "/xrpc/com.atproto.sync.getRecord") {
      const a = accounts.get(u.searchParams.get("did") ?? "");
      if (!a || a.pds !== u.origin) return reply(400, JSON.stringify({ error: "RepoNotFound", message: "Could not find repo" }));
      return reply(200, recordProofCar(a, u.searchParams.get("collection")!, u.searchParams.get("rkey")!), "application/vnd.ipld.car");
    }
    throw new TypeError("Failed to fetch");
  };

  return { accounts, account, zone, wellKnown, asked, fetch, plc };
}

import { describe, expect, it, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ATPROTO_PROOF_COLLECTION, atprotoProofRecord, identityStatement, newIdentityBinding, type IdentityStatement } from "@ghostly/core";
import type { IdentityFetch } from "../src/proofs/contract";
import { createAtprotoIdentityProvider, RECORD_PROOF_MAX_BYTES } from "../src/proofs/providers/atproto";
import { IDENTITY_PROVIDERS } from "../src/proofs/registry";
import { didDocumentUrl, plcDirectory, PLC_DIRECTORY, resolveAtprotoDid, resolveAtprotoHandle, verifiedAtprotoHandle } from "../src/proofs/atproto/resolve";
import { verifyIdentity } from "../src/proofs/verify";
import { describeIdentityProof } from "./helpers/identityProofContract";
import { recordProofCar, testAtprotoNetwork, type TestAccount } from "./helpers/atprotoNetwork";
// covers: proofs.atproto, proofs.atproto.repo, proofs.contract

vi.setConfig({ testTimeout: 30_000 });

const publish = (account: TestAccount, s: IdentityStatement) =>
  account.records.set(`${ATPROTO_PROOF_COLLECTION}/${s.binding.key}`, atprotoProofRecord(s, new Date(s.binding.issuedAt * 1000)));
const statementFor = (subject: string, days = 90) =>
  identityStatement(newIdentityBinding({ provider: "atproto", subject, validitySeconds: days * 86_400 }).binding);
const ctxOf = (fetch: IdentityFetch) => ({ now: Math.floor(Date.now() / 1000), signal: new AbortController().signal, fetch });

describeIdentityProof("Bluesky / AT Protocol", async () => {
  const net = testAtprotoNetwork();
  const alice = net.account("alice"), bob = net.account("bob");
  return {
    provider: createAtprotoIdentityProvider({ host: () => undefined }), subject: alice.did, fetch: net.fetch,
    prove: async s => { publish(alice, s); return {}; },
    // The record is in another account's repository: alice's does not have it.
    proveAsOther: async s => { alice.records.clear(); publish(bob, s); return {}; },
    revoke: () => { alice.records.clear(); },
  };
});

describe("the AT Protocol provider", () => {
  it("is registered, self-custodied, and shows the DID short", () => {
    const p = IDENTITY_PROVIDERS.find(x => x.id === "atproto")!;
    expect(p.label).toBe("Bluesky / AT Protocol");
    expect(p.category).toBe("self-custodied");
    expect(p.subject.short!("did:plc:z72i7hdynmk6r22z27h6tvur")).toBe("did:plc:z72i7h…tvur");
    expect(() => p.subject.normalize("alice.bsky.social")).toThrow("Not an AT Protocol account");
    expect(p.signers.map(s => s.kind)).toEqual(["in-app", "in-app"]);
    expect(p.signers[0].action).toBe("Continue on your server");
    expect(p.unpublish?.description).toMatch(/deletes the record/);
  });

  it("verifies, shows the handle checked both ways, and links the profile", async () => {
    const net = testAtprotoNetwork();
    const alice = net.account("alice");
    const s = statementFor(alice.did);
    publish(alice, s);
    const provider = createAtprotoIdentityProvider({ host: () => undefined });
    const verified = await verifyIdentity([provider], s, {}, ctxOf(net.fetch));
    expect(verified).toMatchObject({ subject: alice.did, source: "Record signed with the account's key, from pds.example.com" });
    expect(verified.display).toMatchObject({ name: "@alice.example.com", url: `https://bsky.app/profile/${alice.did}` });
    expect(verified.display!.source).toMatch(/both ways/);
  });

  it("asks the server the DID document names, and nothing the proof could name", async () => {
    const net = testAtprotoNetwork();
    const alice = net.account("alice", { pds: "https://pds.alice.example" });
    const s = statementFor(alice.did);
    publish(alice, s);
    const provider = createAtprotoIdentityProvider({ host: () => undefined });
    await verifyIdentity([provider], s, {}, ctxOf(net.fetch));
    const hosts = new Set(net.asked.map(u => new URL(u).host));
    expect([...hosts].sort()).toEqual(["dns.quad9.net", "pds.alice.example", "plc.directory"]);
    // Evidence cannot carry a server (or anything else): only {} is accepted.
    for (const raw of [{ pds: "https://evil.example" }, { uri: `at://${alice.did}/x/y` }, null, [], "x"])
      await expect(verifyIdentity([provider], s, raw, ctxOf(net.fetch))).rejects.toThrow("Invalid AT Protocol evidence");
  });

  it("shows no handle when the handle points to another account", async () => {
    const net = testAtprotoNetwork();
    const alice = net.account("alice"), mallory = net.account("mallory");
    // Alice's document claims mallory's handle; that handle resolves to mallory.
    alice.doc.alsoKnownAs = [`at://${mallory.handle}`];
    const s = statementFor(alice.did);
    publish(alice, s);
    const verified = await verifyIdentity([createAtprotoIdentityProvider({ host: () => undefined })], s, {}, ctxOf(net.fetch));
    expect(verified.display?.name).toBeUndefined();
    expect(verified.display?.source).toMatch(/not shown/);
  });

  it.each([
    ["the record was deleted", (a: TestAccount) => a.records.clear(), "no longer in the account's repository"],
    ["the record carries another statement", (a: TestAccount, s: IdentityStatement) => a.records.set(`${ATPROTO_PROOF_COLLECTION}/${s.binding.key}`, { ...atprotoProofRecord(statementFor(a.did), new Date()) }), "another statement"],
    ["the record is not a Ghostly proof", (a: TestAccount, s: IdentityStatement) => a.records.set(`${ATPROTO_PROOF_COLLECTION}/${s.binding.key}`, { $type: "app.bsky.feed.post", text: s.text, createdAt: "x" }), "not a Ghostly proof"],
    ["the DID's key was rotated since", (a: TestAccount) => { (a.doc.verificationMethod as { publicKeyMultibase: string }[])[0].publicKeyMultibase = "zQ3shQo6TF2moaqMTrUZEM1jeuYRQXeHEx4evX9751y2qPqRA"; }, "not signed by the account's key"],
    ["the DID document names an http server", (a: TestAccount) => { (a.doc.service as { serviceEndpoint: string }[])[0].serviceEndpoint = "http://pds.example.com"; }, "https"],
  ])("refuses when %s", async (_name, change, message) => {
    const net = testAtprotoNetwork();
    const alice = net.account("alice");
    const s = statementFor(alice.did);
    publish(alice, s);
    change(alice, s);
    await expect(verifyIdentity([createAtprotoIdentityProvider({ host: () => undefined })], s, {}, ctxOf(net.fetch))).rejects.toThrow(message);
  });

  it.each([
    ["RecordNotFound", "no longer in the account's repository"],
    ["RepoDeactivated", "no longer on its server"],
    ["RepoTakendown", "no longer on its server"],
    ["InternalServerError", "did not send the record"],
  ])("explains a server's %s", async (error, message) => {
    const net = testAtprotoNetwork();
    const alice = net.account("alice");
    const s = statementFor(alice.did);
    const fetch: IdentityFetch = async (url, init) => url.includes("getRecord")
      ? { status: 400, contentType: "application/json", text: JSON.stringify({ error }), bytes: new Uint8Array() } : net.fetch(url, init);
    await expect(verifyIdentity([createAtprotoIdentityProvider({ host: () => undefined })], s, {}, ctxOf(fetch))).rejects.toThrow(message);
  });

  it("bounds the proof it downloads, and says when the server cannot be reached", async () => {
    const net = testAtprotoNetwork();
    const alice = net.account("alice");
    const s = statementFor(alice.did);
    publish(alice, s);
    const limits: (number | undefined)[] = [];
    const fetch: IdentityFetch = async (url, init) => { if (url.includes("getRecord")) limits.push(init?.maxBytes); return net.fetch(url, init); };
    const provider = createAtprotoIdentityProvider({ host: () => undefined });
    await verifyIdentity([provider], s, {}, ctxOf(fetch));
    expect(limits).toEqual([RECORD_PROOF_MAX_BYTES]);
    const big: IdentityFetch = async (url, init) => { if (url.includes("getRecord")) throw new Error("Identity check response too large"); return net.fetch(url, init); };
    await expect(verifyIdentity([provider], s, {}, ctxOf(big))).rejects.toThrow("too large");
    const down: IdentityFetch = async (url, init) => { if (url.includes("getRecord")) throw new TypeError("Failed to fetch"); return net.fetch(url, init); };
    await expect(verifyIdentity([provider], s, {}, ctxOf(down))).rejects.toThrow("could not be reached");
  });

  it("refuses a commit signed by a key other than the DID's", async () => {
    const net = testAtprotoNetwork();
    const alice = net.account("alice");
    const s = statementFor(alice.did);
    publish(alice, s);
    const forged = recordProofCar(alice, ATPROTO_PROOF_COLLECTION, s.binding.key, { signWith: secp256k1.utils.randomSecretKey() });
    const fetch: IdentityFetch = async (url, init) => url.includes("getRecord") ? { status: 200, contentType: "application/vnd.ipld.car", text: "", bytes: forged } : net.fetch(url, init);
    await expect(verifyIdentity([createAtprotoIdentityProvider({ host: () => undefined })], s, {}, ctxOf(fetch))).rejects.toThrow("does not prove the record");
  });
});

describe("AT Protocol resolution", () => {
  it("finds DID documents at the PLC directory, or on the did:web host", () => {
    expect(didDocumentUrl("did:plc:z72i7hdynmk6r22z27h6tvur")).toBe("https://plc.directory/did:plc:z72i7hdynmk6r22z27h6tvur");
    expect(didDocumentUrl("did:web:alice.example.com")).toBe("https://alice.example.com/.well-known/did.json");
    expect(() => didDocumentUrl("did:web:alice.example.com:8080")).toThrow("Not an AT Protocol DID");
    expect(plcDirectory()).toBe(PLC_DIRECTORY);
  });

  it("resolves a did:web account", async () => {
    const net = testAtprotoNetwork();
    const web = net.account("web");
    net.accounts.delete(web.did);
    web.did = "did:web:alice.example.com";
    web.doc.id = web.did;
    (web.doc.verificationMethod as { id: string }[])[0].id = "#atproto";
    net.accounts.set(web.did, web);
    const doc = await resolveAtprotoDid(web.did, { fetch: net.fetch });
    expect(doc).toMatchObject({ did: "did:web:alice.example.com", pds: "https://pds.example.com", handle: "web.example.com" });
  });

  it("explains a DID that is not registered, too large or malformed", async () => {
    const net = testAtprotoNetwork();
    await expect(resolveAtprotoDid("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", { fetch: net.fetch })).rejects.toThrow("not registered");
    const reply = (status: number, text: string): IdentityFetch => async () => ({ status, contentType: "application/json", text, bytes: new TextEncoder().encode(text) });
    await expect(resolveAtprotoDid("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", { fetch: reply(200, "{nope") })).rejects.toThrow("malformed");
    await expect(resolveAtprotoDid("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", { fetch: reply(500, "") })).rejects.toThrow("could not be resolved");
    await expect(resolveAtprotoDid("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", { fetch: async () => { throw new Error("Identity check response too large"); } })).rejects.toThrow("too large");
    const limits: unknown[] = [];
    await resolveAtprotoDid(net.account("a").did, { fetch: async (url, init) => { limits.push([init?.maxBytes, init?.redirect]); return net.fetch(url, init); } });
    expect(limits).toEqual([[32 * 1024, "error"]]);
  });

  it("resolves a handle by DNS first, then HTTPS", async () => {
    const net = testAtprotoNetwork();
    const dns = net.account("dns"), https = net.account("web", { dns: false });
    expect(await resolveAtprotoHandle(dns.handle, { fetch: net.fetch })).toBe(dns.did);
    expect(net.asked.some(u => u.includes("/.well-known/atproto-did"))).toBe(false);
    expect(await resolveAtprotoHandle(https.handle, { fetch: net.fetch })).toBe(https.did);
    expect(net.asked.some(u => u === `https://${https.handle}/.well-known/atproto-did`)).toBe(true);
  });

  it("gives no DID for a handle with two, with garbage, or on a private network", async () => {
    const net = testAtprotoNetwork();
    const a = net.account("a"), b = net.account("b");
    net.zone.txt![`_atproto.${a.handle}`] = [`did=${a.did}`, `did=${b.did}`];
    expect(await resolveAtprotoHandle(a.handle, { fetch: net.fetch })).toBeNull();
    net.zone.txt![`_atproto.${b.handle}`] = ["did=not-a-did"];
    expect(await resolveAtprotoHandle(b.handle, { fetch: net.fetch })).toBeNull();
    const lan = net.account("lan", { dns: false });
    net.zone.a![lan.handle] = ["192.168.1.10"];
    net.asked.length = 0;
    expect(await resolveAtprotoHandle(lan.handle, { fetch: net.fetch })).toBeNull();
    expect(net.asked.some(u => u.startsWith(`https://${lan.handle}/`))).toBe(false);
    net.wellKnown.set("junk.example.com", "<html>");
    net.zone.a!["junk.example.com"] = ["203.0.113.5"];
    expect(await resolveAtprotoHandle("junk.example.com", { fetch: net.fetch })).toBeNull();
  });

  it("verifies a handle only when it points back", async () => {
    const net = testAtprotoNetwork();
    const a = net.account("a");
    const doc = await resolveAtprotoDid(a.did, { fetch: net.fetch });
    expect(await verifiedAtprotoHandle(doc, { fetch: net.fetch })).toBe(a.handle);
    expect(await verifiedAtprotoHandle({ ...doc, handle: undefined }, { fetch: net.fetch })).toBeUndefined();
    net.zone.txt![`_atproto.${a.handle}`] = [`did=${net.account("b").did}`];
    expect(await verifiedAtprotoHandle(doc, { fetch: net.fetch })).toBeUndefined();
    expect(await verifiedAtprotoHandle(doc, { fetch: async () => { throw new Error("offline"); } })).toBeUndefined();
  });
});

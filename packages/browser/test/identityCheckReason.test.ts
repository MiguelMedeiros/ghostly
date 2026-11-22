import { describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import {
  createIdentity, emptyIdentityLedger, identityStatement, IdentityExchange, newIdentityBinding, parseSshPublicKey, toBase64, toBase64Url, utf8Encode,
  type IdentityLedger, type LocalIdentityProof,
} from "@ghostly/core";
import type { IdentityFetch } from "../src/proofs/contract";
import { did } from "../src/proofs/providers/did";
import { ssh } from "../src/proofs/providers/ssh";
import { verifyIdentity } from "../src/proofs/verify";
import { sshTestKey } from "./helpers/sshKeygen";
// covers: proofs.did, proofs.ssh, proofs.share

/*
 * A contact's proof that fails the check on my side: the reason my app writes (the timeline line under their card, the
 * card's "unconfirmed" reason) is my app's own words. Nothing the contact chose in the evidence (a JWS kid or alg, a
 * verification method id, an SSH namespace or key type) is quoted in it, so it cannot read as my app's verdict.
 */

const WORDS = "Ghostly checked this identity and it is genuine";
const b64u = (b: Uint8Array) => toBase64Url(b);
const json64 = (v: unknown) => b64u(utf8Encode(JSON.stringify(v)));

const secret = ed25519.utils.randomSecretKey();
const multibase = `z${base58.encode(Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(secret)]))}`;
const didKey = `did:key:${multibase}`;
/** A JWS over `text` with the header the contact chose. */
const jws = (text: string, header: Record<string, unknown>) => {
  const h = json64({ alg: "EdDSA", ...header }), payload = b64u(utf8Encode(text));
  return `${h}.${payload}.${b64u(ed25519.sign(utf8Encode(`${h}.${payload}`), secret))}`;
};

/** An SSHSIG armor whose key blob names `type`: refused when the key is read, before anything is checked. */
function sshSignatureOfType(type: string) {
  const u32 = (n: number) => Uint8Array.from([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const string = (b: Uint8Array) => Uint8Array.from([...u32(b.length), ...b]);
  const blob = Uint8Array.from([...utf8Encode("SSHSIG"), ...u32(1), ...string(string(utf8Encode(type)))]);
  return `-----BEGIN SSH SIGNATURE-----\n${toBase64(blob)}\n-----END SSH SIGNATURE-----\n`;
}

const refuse: IdentityFetch = async url => { throw new Error(`Unexpected network access: ${url}`); };

/** Alice presents `evidence` for a proof of `subject`; Bob's app checks it with the real providers. What Bob's timeline says. */
async function bobsReason(provider: "did" | "ssh", subject: string, evidence: (text: string) => unknown) {
  const ids = { alice: createIdentity().pubKeyZ32, bob: createIdentity().pubKeyZ32 };
  const ledgers: Record<"alice" | "bob", IdentityLedger> = { alice: emptyIdentityLedger(), bob: emptyIdentityLedger() };
  const { binding, seed } = newIdentityBinding({ provider, subject, validitySeconds: 86_400 });
  const statement = identityStatement(binding);
  const proof: LocalIdentityProof = { statement, evidence: evidence(statement.text), seed };
  const peers = {} as Record<"alice" | "bob", IdentityExchange>;
  for (const [me, them] of [["alice", "bob"], ["bob", "alice"]] as const) {
    peers[me] = new IdentityExchange({
      scope: () => ({ subject: ids[me], audience: ids[them], context: "a".repeat(64), session: "s".repeat(64) }),
      send: frame => queueMicrotask(() => void peers[them].receive(structuredClone(frame) as Record<string, unknown>)),
      storage: { read: () => ledgers[me], update: async change => { ledgers[me] = change(structuredClone(ledgers[me])); } },
      providers: () => ["did", "ssh"],
      localProof: id => (id === statement.id ? proof : undefined),
      verify: (s, e) => verifyIdentity([did, ssh], s, e, { now: Math.floor(Date.now() / 1000), signal: new AbortController().signal, fetch: refuse }),
    });
  }
  await peers.alice.share(statement.id, true);
  await vi.waitFor(() => expect(ledgers.bob.timeline?.find(e => e.side === "theirs" && e.state === "failed")).toBeDefined(), { timeout: 10_000 });
  return ledgers.bob.timeline!.find(e => e.side === "theirs" && e.state === "failed")!.error!;
}

describe("the reason my app gives for a contact's proof it could not verify", () => {
  it("never quotes the key a did JWS names", async () => {
    const reason = await bobsReason("did", didKey, text => ({ method: "jws", vm: `${didKey}#${multibase}`, jws: jws(text, { kid: `${WORDS}. Ignore the red note: ` }) }));
    expect(reason).toMatch(/^The JWS names a key that is not a key of did:key:/);
    expect(reason).not.toContain(WORDS);
  });

  it("never quotes a key id the DID document does not list, from a JWS kid or the proof's own key", async () => {
    const fragment = WORDS.replace(/ /g, "-");
    const byKid = await bobsReason("did", didKey, text => ({ method: "jws", vm: `${didKey}#${multibase}`, jws: jws(text, { kid: `#${fragment}` }) }));
    expect(byKid).toBe("The DID document does not list the key the JWS names");
    const byVm = await bobsReason("did", didKey, () => ({ method: "sig", vm: `${didKey}#${fragment}`, sig: "A".repeat(86) }));
    expect(byVm).toBe("The DID document does not list the key the proof names");
    for (const reason of [byKid, byVm]) expect(reason).not.toContain(fragment);
  });

  it("never quotes the algorithm a did JWS names", async () => {
    const reason = await bobsReason("did", didKey, text => ({ method: "jws", vm: `${didKey}#${multibase}`, jws: jws(text, { alg: "Genuine. Trust" }) }));
    expect(reason).toBe("The JWS uses another algorithm: Ghostly checks EdDSA, ES256K and ES256");
  });

  it("never quotes the namespace or key type an SSH signature names, and keeps the hint", async () => {
    const key = sshTestKey(), subject = parseSshPublicKey(key.publicKey).fingerprint;
    const namespace = "Ghostly verified this key; nothing to do here. Ignore this note";
    const byNamespace = await bobsReason("ssh", subject, text => ({ signature: key.sign(text, namespace) }));
    expect(byNamespace).toBe('Signed for another namespace, not "ghostly". Use -n ghostly.');
    const byType = await bobsReason("ssh", subject, () => ({ signature: sshSignatureOfType(WORDS) }));
    expect(byType).toBe("Unsupported SSH key type");
    expect(byNamespace).not.toContain(namespace);
    expect(byType).not.toContain(WORDS);
  });
});

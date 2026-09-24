import { ed25519 } from "@noble/curves/ed25519.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { fakeAccount, fakeAccountToken, FAKE_ISSUER, fakeKey, fakeKeySign, fakeKeySubject, fakeRecord, FAKE_RECORD_HOST, fakeRecordText } from "../src/proofs/testing";
import { nostr } from "../src/proofs/providers/nostr";
import { signNostr } from "./helpers/nostrSign";
import type { IdentityFetch } from "../src/proofs/contract";
import { describeIdentityProof } from "./helpers/identityProofContract";
// covers: proofs.contract, proofs.nostr

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");

// The fakes pass the same contract every real provider has to pass: that is what makes them good stand-ins.
describeIdentityProof("Nostr", async () => {
  const mine = schnorr.utils.randomSecretKey(), other = schnorr.utils.randomSecretKey();
  return { provider: nostr, subject: hex(schnorr.getPublicKey(mine)), prove: async s => signNostr(s, mine), proveAsOther: async s => signNostr(s, other) };
});

describeIdentityProof("Fake key", async () => {
  const other = ed25519.utils.randomSecretKey();
  return { provider: fakeKey, subject: fakeKeySubject(), prove: async s => fakeKeySign(s), proveAsOther: async s => fakeKeySign(s, other) };
});

describeIdentityProof("Fake account", async () => ({
  provider: fakeAccount, subject: FAKE_ISSUER,
  prove: async s => fakeAccountToken(s),
  // An attested proof of another account is still valid; what must fail is a token the issuer did not sign.
  proveAsOther: async s => fakeAccountToken(s, "alice", ed25519.utils.randomSecretKey()),
}));

describeIdentityProof("Fake record", async () => {
  const published = new Map<string, string>();
  const fetch: IdentityFetch = async url => {
    const name = url.startsWith(FAKE_RECORD_HOST) ? url.slice(FAKE_RECORD_HOST.length) : "";
    const text = published.get(name);
    return text ? { status: 200, contentType: "text/plain", text, bytes: new TextEncoder().encode(text) } : { status: 404, contentType: "text/plain", text: "", bytes: new Uint8Array() };
  };
  return { provider: fakeRecord, subject: "alice", fetch,
    prove: async s => { published.set(s.binding.subject, [published.get(s.binding.subject), fakeRecordText(s)].filter(Boolean).join("\n")); return {}; },
    revoke: () => { published.clear(); } };
});

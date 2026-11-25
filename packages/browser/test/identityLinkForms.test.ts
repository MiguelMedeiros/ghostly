import { schnorr } from "@noble/curves/secp256k1.js";
import { createIdentity } from "@ghostly/core";
import { neventEncode, noteEncode, nprofileEncode, npubEncode } from "nostr-tools/nip19";
import { describe, expect, it } from "vitest";
import { IDENTITY_PROVIDERS } from "../src/proofs/registry";
import { MAINNET, SIGNET, testBitcoinWallet } from "./helpers/bitcoinSign";
// covers: proofs.contract, proofs.bitcoin, proofs.domain.dns, proofs.domain.https, proofs.nostr, proofs.openpgp, proofs.ssh.github, proofs.ssh.gitlab, proofs.atproto

/**
 * Add takes back the link a provider writes for its own subjects (`publicUri`), the way wallets, Nostr clients and
 * OpenPGP apps copy it, and keeps refusing every other form: a link must never name another subject than its bare
 * value would.
 */
const provider = (id: string) => {
  const p = IDENTITY_PROVIDERS.find(x => x.id === id);
  if (!p) throw new Error(`no provider ${id}`);
  return p;
};
const normalize = (id: string, input: string) => provider(id).subject.normalize(input);

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
const nostrKey = hex(schnorr.getPublicKey(new Uint8Array(32).fill(7)));
const npub = npubEncode(nostrKey);
const segwit = testBitcoinWallet("p2wpkh", MAINNET).address;
const taproot = testBitcoinWallet("p2tr", MAINNET).address;
const legacy = testBitcoinWallet("p2pkh", MAINNET).address;
const testnet = testBitcoinWallet("p2wpkh", SIGNET).address;
const otherSegwit = testBitcoinWallet("p2wpkh", MAINNET).address;
const pubkyKey = createIdentity().pubKeyZ32;
const fpr = "0123456789ABCDEF0123456789ABCDEF01234567";
const fpr6 = "AB".repeat(32);

/** One canonical subject per provider that writes a link. A new provider with `publicUri` adds its own here. */
const SUBJECTS: Record<string, string[]> = {
  nostr: [nostrKey],
  pubky: [pubkyKey],
  domain: ["example.com", "alice.example.co.uk", "xn--bcher-kva.de"],
  openpgp: [fpr, fpr6],
  bitcoin: [segwit, taproot, legacy, testnet],
  "ssh-github": ["octocat"],
  "ssh-gitlab": ["gitlab.user_1"],
  did: ["did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK", "did:web:example.com"],
  atproto: ["did:plc:z72i7hdynmk6r22z27h6tvur"],
};

describe("every provider takes back the link it writes", () => {
  it("has a subject to try for each provider with a publicUri", () => {
    const linking = IDENTITY_PROVIDERS.filter(p => p.publicUri).map(p => p.id);
    expect(linking.filter(id => !SUBJECTS[id])).toEqual([]);
  });

  for (const [id, subjects] of Object.entries(SUBJECTS)) {
    it.each(subjects)(`${id}: normalize(publicUri(%s)) is the subject again`, subject => {
      const p = provider(id);
      expect(p.subject.normalize(subject)).toBe(subject);
      const uri = p.publicUri?.(subject);
      expect(uri).toBeTruthy();
      expect(p.subject.normalize(uri!)).toBe(subject);
    });
  }
});

describe("the link forms Add takes", () => {
  it.each<[string, string, string]>([
    // BIP-21: the scheme in any case (a QR code is upper case), the query dropped: only the address before it counts.
    ["bitcoin", `bitcoin:${segwit}`, segwit],
    ["bitcoin", `BITCOIN:${segwit.toUpperCase()}`, segwit],
    ["bitcoin", ` Bitcoin:${taproot} `, taproot],
    ["bitcoin", `bitcoin:${segwit}?amount=0.001&label=Alice`, segwit],
    ["bitcoin", `bitcoin:${segwit}?address=${otherSegwit}`, segwit],
    ["bitcoin", `bitcoin:${legacy}?amount=1`, legacy],
    ["bitcoin", `bitcoin:${testnet}`, testnet],
    // NIP-21.
    ["nostr", `nostr:${npub}`, nostrKey],
    ["nostr", `NOSTR:${npub}`, nostrKey],
    ["nostr", ` nostr:${npub}\n`, nostrKey],
    // The fingerprint URI OpenPGP apps share (0x and spaces were already dropped).
    ["openpgp", `openpgp4fpr:${fpr}`, fpr],
    ["openpgp", `OPENPGP4FPR:${fpr.toLowerCase()}`, fpr],
    ["openpgp", `openpgp4fpr:${fpr6}`, fpr6],
    // NIP-05's root identifier, and a web address over http or with its trailing slash, like https:// already.
    ["domain", "_@example.com", "example.com"],
    ["domain", " _@Example.COM. ", "example.com"],
    ["domain", "_@bücher.de", "xn--bcher-kva.de"],
    ["domain", "_@xn--bcher-kva.de", "xn--bcher-kva.de"],
    ["domain", "http://example.com", "example.com"],
    ["domain", "HTTP://Example.com/", "example.com"],
    ["domain", "example.com/", "example.com"],
    ["domain", "https://example.com/", "example.com"],
    // The account's profile address and AT URI.
    ["ssh-github", "https://github.com/octocat", "octocat"],
    ["ssh-github", "HTTPS://GitHub.com/Octocat/", "octocat"],
    ["ssh-gitlab", "https://gitlab.com/gitlab.user_1", "gitlab.user_1"],
    ["atproto", "at://did:plc:z72i7hdynmk6r22z27h6tvur", "did:plc:z72i7hdynmk6r22z27h6tvur"],
    ["atproto", "AT://did:plc:z72i7hdynmk6r22z27h6tvur", "did:plc:z72i7hdynmk6r22z27h6tvur"],
    ["pubky", `pubky://${pubkyKey}/`, pubkyKey],
  ])("%s takes %j", (id, input, subject) => {
    expect(normalize(id, input)).toBe(subject);
  });
});

describe("the forms Add still refuses, with the words it had", () => {
  const mixedCase = `${segwit.slice(0, 10)}${segwit.slice(10).toUpperCase()}`;
  it.each<[string, string, string | RegExp]>([
    // Only BIP-21's own scheme; mixed-case bech32 stays invalid, and nothing in the query is ever taken.
    ["bitcoin", `bitcoin://${segwit}`, /^Not a Bitcoin address/],
    ["bitcoin", `bitcoin:${mixedCase}`, /^Not a Bitcoin address/],
    ["bitcoin", `bitcoin:?address=${segwit}`, /^Not a Bitcoin address/],
    ["bitcoin", "bitcoin:", /^Not a Bitcoin address/],
    ["bitcoin", `bitcoin: ${segwit}`, /^Not a Bitcoin address/],
    ["bitcoin", `bitcoin:${segwit}#x`, /^Not a Bitcoin address/],
    ["bitcoin", `bitcoin:${segwit.slice(0, 8)}\u200b${segwit.slice(8)}`, /^Not a Bitcoin address/],
    ["bitcoin", `litecoin:${segwit}`, /^Not a Bitcoin address/],
    // A profile, an event or a note is not a public key: no relay hint or id is taken for one.
    ["nostr", `nostr:${nprofileEncode({ pubkey: nostrKey, relays: ["wss://relay.example.com"] })}`, "Enter a Nostr public key: npub1… or 64 hex characters"],
    ["nostr", `nostr:${neventEncode({ id: nostrKey, author: nostrKey })}`, "Enter a Nostr public key: npub1… or 64 hex characters"],
    ["nostr", `nostr:${noteEncode(nostrKey)}`, "Enter a Nostr public key: npub1… or 64 hex characters"],
    ["nostr", `nostr:${nostrKey}`, "Enter a Nostr public key: npub1… or 64 hex characters"],
    ["nostr", `nostr://${npub}`, "Enter a Nostr public key: npub1… or 64 hex characters"],
    ["nostr", `nostr:${npub.slice(0, 10)}${npub.slice(10).toUpperCase()}`, "Enter a Nostr public key: npub1… or 64 hex characters"],
    ["nostr", `nostr:nostr:${npub}`, "Enter a Nostr public key: npub1… or 64 hex characters"],
    ["openpgp", `openpgp4fpr:${fpr.slice(-16)}`, "Use the full fingerprint, not a key ID: gpg --fingerprint shows it."],
    ["openpgp", `openpgp4fpr://${fpr}`, "Enter your key's fingerprint: 40 hex characters (gpg --fingerprint)."],
    ["openpgp", `openpgp4fpr:${fpr}?x=1`, "Enter your key's fingerprint: 40 hex characters (gpg --fingerprint)."],
    ["openpgp", `pgp:${fpr}`, "Enter your key's fingerprint: 40 hex characters (gpg --fingerprint)."],
    // A person's NIP-05 name is not the domain; nor is a page, a port or another scheme.
    ["domain", "alice@example.com", "Enter only the domain name, without a path or port"],
    ["domain", "_@_@example.com", "Enter only the domain name, without a path or port"],
    ["domain", "_@example.com/x", "Enter only the domain name, without a path or port"],
    ["domain", "_@https://example.com", "Enter only the domain name, without a path or port"],
    ["domain", "http://_@example.com", "Enter only the domain name, without a path or port"],
    ["domain", "http://example.com:8080", "Enter only the domain name, without a path or port"],
    ["domain", "http://example.com/page", "Enter only the domain name, without a path or port"],
    ["domain", "example.com/page", "Enter only the domain name, without a path or port"],
    ["domain", "example.com//", "Enter only the domain name, without a path or port"],
    ["domain", "_ @example.com", "Enter only the domain name, without a path or port"],
    ["domain", "_@exa mple.com", "Enter only the domain name, without a path or port"],
    ["domain", "ftp://example.com", "Enter only the domain name, without a path or port"],
    ["domain", "_@", "Enter a domain name, like example.com"],
    ["domain", "/", "Enter a domain name, like example.com"],
    ["domain", "_@localhost.test", "That name only works on private networks"],
    ["ssh-github", "https://gitlab.com/octocat", "Enter a GitHub username"],
    ["ssh-github", "https://github.com.example.com/octocat", "Enter a GitHub username"],
    ["ssh-github", "https://example.com/github.com/octocat", "Enter a GitHub username"],
    ["ssh-github", "https://github.com/octocat/hello-world", "Enter a GitHub username"],
    ["ssh-github", "https://github.com/", "Enter a GitHub username"],
    ["ssh-github", "https://octocat@github.com/octocat", "Enter a GitHub username"],
    ["ssh-gitlab", "https://github.com/octocat", "Enter a GitLab username"],
    ["atproto", "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3k", "Not an AT Protocol account (did:plc or did:web)"],
    ["atproto", "at://alice.bsky.social", "Not an AT Protocol account (did:plc or did:web)"],
    ["atproto", "at:did:plc:z72i7hdynmk6r22z27h6tvur", "Not an AT Protocol account (did:plc or did:web)"],
  ])("%s refuses %j", (id, input, message) => {
    expect(() => normalize(id, input)).toThrow(message);
  });

  it("keeps a test-network address on the test network", () => {
    expect(normalize("bitcoin", `bitcoin:${testnet}?amount=1`)).toBe(testnet);
    expect(provider("bitcoin").subject.short!(normalize("bitcoin", `bitcoin:${testnet}`))).toMatch(/test network$/);
  });
});

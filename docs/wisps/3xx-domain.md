# WISP 3xx — Domain Proofs

| Field | Value |
|---|---|
| Number assignment | 3xx; planned, number to be defined |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-23 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [300](300-peer-proofs.md) |
| Implementation | Experimental provider `domain`: `packages/core/src/domainProofs.ts`, `packages/browser/src/proofs/domain.ts`, `packages/browser/src/proofs/providers/domain.ts` |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Purpose

A person shows a contact that they control a domain name, such as `example.com`, by publishing a record under it. It is an optional identity proof under [300](300-peer-proofs.md) and the [provider contract](../../packages/browser/src/proofs/PROOFS.md): chat works without it, it is shared with one contact at a time, and it says nothing about who holds the domain in law.

A verified domain proof establishes: *at the last check, `example.com` published a record naming this Ghostly proof key and this exact statement, and the holder of that proof key presented it to this contact in this conversation.* It does not establish that the domain is trustworthy, that the person is its registrant, or that they still control it after the record changes.

## How it composes with WISP 300

The contract's statement is made once per proof:

```
Ghostly identity proof v1: I control domain:example.com and authorize the Ghostly key <proof key> to present it to contacts I choose, from <issuedAt> until <expiresAt>. Nonce: <nonce>
```

A signature-based provider (Nostr, SSH…) signs that line. A domain cannot sign; it **publishes**. The record names the proof key and the statement id (SHA-256 of the statement bytes, lowercase hex), so it vouches for exactly one statement: its subject, key, dates and nonce. Per contact, the contract's shared code does the rest: the contact's fresh challenge, the proof key's presentation over both participation keys, the conversation, the session and the challenge, replay protection, withdrawal and storage.

The record names **no participation key, no contact and no conversation**. Publishing it links the domain to one proof key, which is a fresh key per proof, so it links nothing else. It is published once and serves every contact the person chooses.

## Domain names

Normalized before any use, by the prover's subject field and again by every verifier: lowercase ASCII, punycode for internationalized names, no trailing dot, at least two labels, at most 244 octets (so `_ghostly.` fits in 253), LDH labels. A statement whose subject is not already canonical is refused before any lookup. IP literals and names that only resolve on private networks are refused: `localhost`, `local`, `internal`, `lan`, `home`, `corp`, `intranet`, `private`, `test`, `example`, `invalid`, `onion`, `alt`, `arpa`, `home.arpa`. A subdomain proves itself: `alice.example.com` publishes under `alice.example.com`.

## Methods and record formats

The evidence says which method the verifier checks: exactly `{"method":"dns"}`, `{"method":"https"}` or `{"method":"nip05","event":<signed Nostr event>}`, no other fields. The verifier builds every name and URL from the statement's domain, never from the evidence.

### `dns`: TXT record at `_ghostly.<domain>`

```
_ghostly.example.com.  300  TXT  "v=ghostly1; key=<52-character z-base-32 proof key>; proof=<64 hex statement id>"
```

- A tag list in the style of DKIM (RFC 6376 §3.2): tag names are case-insensitive, `v=ghostly1` MUST come first, `key` and `proof` are required and must be canonical, a duplicated tag or a bare word invalidates the string, unknown tags are ignored.
- The value is about 140 octets, one character-string; multi-string records are concatenated (RFC 7208 §3.3).
- Several TXT records at the name are allowed (several proofs, a renewal in progress); the one naming this key and statement suffices. Other TXT strings are ignored; at most 32 strings are read and 8 records kept; a string over 1024 octets is ignored. A CNAME is followed as the resolver's answer gives it, up to 8 hops.

### `https`: `https://<domain>/.well-known/ghostly.json`

```json
{ "ghostly": 1, "proofs": [ { "key": "<proof key>", "proof": "<statement id>" } ] }
```

`ghostly` MUST be `1`; entries it does not understand are skipped; at most 8 kept; 16 KiB. The server MUST send `Access-Control-Allow-Origin: *` (apps read it cross-origin) and serve it at exactly that URL: redirects are refused, including `example.com` → `www.example.com`.

### `nip05`: an existing NIP-05 `nostr.json`

For people who already run NIP-05. The statement is signed by a Nostr key exactly as the `nostr` provider signs it (NIP-78 kind 30078, content the statement, tags `d` and `expiration`, checked by the same code), and `https://<domain>/.well-known/nostr.json?name=_` must name **that same key** for `_`, the name NIP-05 uses for the domain itself. A NIP-05 file naming another key, or only other names (`bob@example.com`, a claim by the domain about someone else), proves nothing here. The file is fetched under the `https` rules.

## Verification

1. **Shared checks** (contract): known provider, validity ≤ 365 days (default 90), evidence ≤ 16 KiB, strict parsing, presentation, category rule.
2. **Canonical domain** of the statement.
3. **Lookup**, only through the engine's bounded `ctx.fetch` (HTTPS GET, no credentials or referrer, 10 s time-out, redirects refused):
   - **DNS**: an RFC 8484 GET to the DNS-over-HTTPS resolver chosen on this device: Quad9 (default), Cloudflare or Google, all checked to answer browsers (CORS) on 2026-09-23. The query has ID 0, RD and AD set, no EDNS client subnet. The answer must be `application/dns-message`, at most 16 KiB, answer this question, not be truncated; NOERROR and NXDOMAIN are answers, other codes are failures. The resolver's AD flag is reported as "DNSSEC validated", not required.
   - **HTTPS / NIP-05**: first A and AAAA through the same resolver; the domain must have an address and **every** address must be public (no loopback, private, link-local, CGNAT, multicast, reserved or unspecified, including IPv4 embedded in IPv6). Then one GET of the file, UTF-8, 16 KiB. 404/410 mean "not published".
4. **Match**: the record names this proof key and this statement id (NIP-05: the signing key). The failure message says which of "not published", "names another key: replaced or removed", "another proof of this key", "unreachable", "redirect", "too large", "private network" happened.

Re-checks: the provider declares `recheck: { afterSeconds: 86400 }`; the contact's app offers "Check again" after a day and shows a failed re-check as not confirmed, without deleting the proof. Removing the record therefore withdraws the proof from every contact at their next check.

Caching: DNS answers are shared between checks for their TTL, capped at 30 s, which is never staler than the resolver itself; files are shared only while one fetch is in flight. Publish with a TTL of 300 s or less so a removal is seen quickly; resolvers may keep an old answer for up to the TTL.

## Privacy

What a check discloses, as the provider's `privacy` line tells the person before they share:

- **DNS**: the chosen resolver learns that this device looked up `_ghostly.<domain>`. The domain's servers see the resolver, not the device.
- **HTTPS / NIP-05**: the resolver learns the domain, and the domain's web server — run by the person being checked — sees the contact's IP address and when it checked. This is the cost of the file methods; DNS avoids it.
- The record is public for as long as it is published: anyone can see that `example.com` vouches for that proof key, but not with whom it was shared.

## Security considerations

- **DNS rebinding.** The address check uses the resolver's answer; the browser resolves again when it fetches. A name that answers differently in between is not fully excluded. Browsers' private network access protections are a second line; a native fetcher pinning the checked address would close it.
- **Resolver trust.** Without DNSSEC the chosen resolver is trusted to answer honestly. With AD set, it says it validated.
- **Domain transfer.** Whoever controls the domain later controls the record. Re-checks catch removal, not a new owner who keeps the record; the proof's own expiry bounds that.
- **Lost proof key or profile.** Remove the record; the proof fails at every contact's next check. Make a new proof and publish its record.

## Conformance

Formats: TXT tags strict; `ghostly.json` and `nostr.json` bounded and strict; NIP-05 root name only, and only the signing key. Binding: every field of the statement counts (the contract suite). Network: private and loopback addresses never contacted; redirects, oversize, time-outs and unusable DNS answers fail; a removed record fails the next re-check. Evidence: `packages/core/test/domainProofs.test.ts`, `packages/browser/test/domainProofs.test.ts`, `packages/browser/test/domainProvider.test.ts` (contract suite for all three methods), `e2e/web/domain-proof.spec.ts` (two peers, a test domain served locally).

## References

[300](300-peer-proofs.md), [provider contract](../../packages/browser/src/proofs/PROOFS.md), [NIP-05](https://github.com/nostr-protocol/nips/blob/master/05.md), [NIP-78](https://github.com/nostr-protocol/nips/blob/master/78.md), [RFC 8484](https://www.rfc-editor.org/rfc/rfc8484), [RFC 8615](https://www.rfc-editor.org/rfc/rfc8615), [RFC 6761](https://www.rfc-editor.org/rfc/rfc6761), [RFC 6840 §5.7](https://www.rfc-editor.org/rfc/rfc6840#section-5.7), [RFC 6376 §3.2](https://www.rfc-editor.org/rfc/rfc6376#section-3.2), [RFC 7208 §3.3](https://www.rfc-editor.org/rfc/rfc7208#section-3.3).

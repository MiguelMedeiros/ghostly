# WISP 3xx: Decentralized identifiers (DIDs)

| Field | Value |
|---|---|
| Number assignment | 3xx; planned, number to be defined |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-25 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [300](300-peer-proofs.md); did:dht resolution: the did:dht draft (pull request 247) |
| Implementation | Experimental provider `did`; see below |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Scope

An optional identity proof, under [300](300-peer-proofs.md), that a person controls a [W3C decentralized identifier](https://www.w3.org/TR/did-core/). The DID vouches, once, for the WISP 300 **binding statement**, which authorizes the profile's own proof key for a validity period; each chat the proof is shared with then gets a presentation signed by that proof key (shared WISP 300 machinery, no DID involved). A contact's app resolves the DID itself and checks the evidence against what the DID document says.

Four methods are supported: `did:key` and `did:jwk` (the key is the identifier), `did:dht` (a document signed by its key, published on the Mainline DHT through Pkarr), and `did:web` (a document served over HTTPS). Any other method is refused with "not supported yet". Accounts whose DID is `did:plc` (Bluesky) belong to a separate provider. The profile's own Ghostly `did:dht` is refused as an external identity: contacts already see the Ghostly identity.

## Subject

The subject is the DID itself, in canonical form, at most 512 printable ASCII characters:

- `did:key:z…`: a multibase base58btc multicodec key, Ed25519 (`0xed01`), secp256k1 (`0xe701`, compressed) or P-256 (`0x1200`, compressed). An X25519 did:key is an encryption key and is refused.
- `did:jwk:…`: base64url (no padding) of a public JWK: `OKP`/`Ed25519`, or `EC` with `secp256k1` or `P-256`. A JWK carrying a private member (`d`, `p`, `k`) is refused with a warning. A JWK marked `"use": "enc"` cannot sign.
- `did:dht:<52 z-base-32 characters>`, lowercased.
- `did:web:<host>[%3A<port>][:<segment>…]`: the host lowercased and checked like the [domain proof](3xx-domain.md) (a public name, no IP address, no special-use or private name), at most 8 path segments of `[A-Za-z0-9._~-]`.

A DID URL (with a `#fragment`, `?query` or `/path`) is not a DID and is refused.

## Resolution

| Method | Document | What the network learns |
|---|---|---|
| `did:key` | built from the identifier: one verification method `<did>#<multibase>`, in `authentication` and `assertionMethod` | nothing |
| `did:jwk` | built from the identifier: `<did>#0`, in both unless `"use": "enc"` | nothing |
| `did:dht` | the Pkarr record under the DID's key, its signature checked against that key (the did:dht draft); a deactivated DID is refused | the Pkarr relay learns which DID was looked up |
| `did:web` | `https://<host>/.well-known/did.json`, or `https://<host>/<path>/did.json` | the DNS-over-HTTPS resolver learns the domain; the domain's web server sees the verifier's IP address |

For `did:web`, the verifier first resolves the host's A and AAAA records through the DNS-over-HTTPS resolver the person chose, and does not contact a host with any private, loopback, link-local or otherwise non-public address. The GET is HTTPS only, without credentials or referrer, with a 10 second time-out and at most 64 KiB, and **no redirect is followed**. The server must send `Access-Control-Allow-Origin: *` so browsers may read it.

The document is parsed strictly: its `id` must be the DID; `verificationMethod`, `authentication`, `assertionMethod` and `service` must be lists, of which 64 entries are read. Verification methods are taken from `verificationMethod` and from entries embedded in `authentication` / `assertionMethod`; relative ids (`#key-1`) are resolved against the DID, and ids of another DID are ignored. Key material is read from `publicKeyJwk`, `publicKeyMultibase` (Multikey and `Ed25519VerificationKey2020`) or, for `Ed25519VerificationKey2018`, `publicKeyBase58`; every point is validated on its curve. Other key types are counted and shown as not usable.

Resolutions are shared for 30 seconds between back-to-back checks, never longer.

## Proof of control

### Signature (every method)

The person signs the exact statement with the private key of a verification method their document lists under **`authentication` or `assertionMethod`**. A key listed only for key agreement, capability invocation or delegation does not speak for the DID and is refused, with its id named. The private key never enters Ghostly. Two forms are accepted:

- **A compact JWS**, attached (the payload is the statement), detached (`header..signature`, the payload being the base64url statement) or unencoded detached ([RFC 7797](https://www.rfc-editor.org/rfc/rfc7797), `"b64": false` listed in `crit`). `alg` is `EdDSA` or `Ed25519` (Ed25519, [RFC 8037](https://www.rfc-editor.org/rfc/rfc8037)), `ES256K` (secp256k1, [RFC 8812](https://www.rfc-editor.org/rfc/rfc8812)) or `ES256` (P-256); the signature is 64 bytes. A `kid` narrows the check to that verification method. Any other `crit` extension, and keys offered in the header (`jwk`, `jku`, `x5c`), are never used.
- **A raw signature** in hex, base64 or base64url, optionally after the verification method id (`#key-1 <signature>`): Ed25519 over the statement bytes, or ECDSA with SHA-256 on secp256k1 or P-256, as 64 bytes `r‖s` or DER (as OpenSSL writes it). High and low S are both accepted.

The signed message is the statement, or the statement followed by one newline (`echo` adds it); nothing else. The app shows copyable snippets for [jose](https://github.com/panva/jose) (Ed25519 and P-256), [@noble/curves](https://github.com/paulmillr/noble-curves) and OpenSSL 3, filled in with the statement and, when the document names one key, its id.

Evidence, strict JSON with no other members:

```
{ "method": "jws", "vm": "<did>#<fragment>", "jws": "<compact JWS, at most 4096 characters>" }
{ "method": "sig", "vm": "<did>#<fragment>", "sig": "<64 bytes, base64url>" }
```

`vm` is the verification method that signed, recorded when the proof is made. The verifier resolves the DID again, finds which listed key made the signature, and refuses the evidence unless it is `vm` and it is in `authentication` or `assertionMethod`.

### Publication (did:web only)

A `did:web` can instead publish the statement where its document lives, like the domain proof's file:

- **A file beside did.json**: `https://<host>/.well-known/ghostly/<statement id>.json` for a bare domain, `https://<host>/<path>/ghostly/<statement id>.json` for a DID with a path, containing `{"ghostly": 1, "did": "<did>", "statement": "<the exact statement>"}`. Fetched under the same rules as did.json, 16 KiB at most. Evidence: `{ "method": "file" }`.
- **A service in did.json**: `{"id": "<did>#ghostly-<first 12 hex of the id>", "type": "GhostlyIdentityProof", "serviceEndpoint": {"key": "<proof key>", "proof": "<statement id>"}}`. Evidence: `{ "method": "service" }`.

The verifier requires did.json to resolve as well, so the proof is for a live DID, not only a web server.

## Re-checks and revocation

A `did:web` or `did:dht` document can change: a key rotated out, a file or service removed. The provider declares a one-day re-check: the contact's app offers "Check again" and, when the key, file or service is gone, shows the proof as "could not be confirmed" rather than verified. Early revocation is WISP 300's: removing the proof from the profile publishes the proof key's `_ghostly-revoked` Pkarr record. A `did:key` or `did:jwk` never changes; only the Pkarr revocation and expiry end its proof.

## Presentation in the app

"DID" is listed under **Advanced** in the Add identity picker. The person pastes a DID; the app resolves it first and shows the method, the domain and document URL (did:web) or relay (did:dht), the keys that can sign (their fragment and curve) and how many cannot; only then does it offer Sign or, for a did:web, Publish. The ID card shows the DID in short form (`did:key:z6Mkha…doK`, `did:web:example.com`), the panel shows it whole and copyable, and "how it was checked" names the method and the verification method used (`did:web · ES256K JWS by #key-1`).

## Security considerations

- A DID proves control of a key or a web location at signing time, not a civil identity. The same DID across contacts links those conversations.
- `did:web` is as strong as the domain and its TLS certificate: whoever controls the web server controls the DID. A DID with a path is controlled by whoever can write that path.
- `did:key` and `did:jwk` cannot rotate or be deactivated; a stolen key can make a valid proof until the binding expires.
- The verifier never follows a URL from the evidence or the document: it fetches only the did.json and file URLs derived from the DID, and the Pkarr relays it is configured with.
- Parsing is bounded before any cryptography runs; malformed input fails closed and never affects the chat.

## Conformance

`packages/core/test/did.test.ts` checks the did:key test vectors of the method specification (Ed25519 from the all-zero seed, secp256k1 and P-256), the did:jwk examples (P-256, and X25519 marked for encryption), the RFC 8037 A.4 Ed25519 JWS, JWS in every accepted shape and raw signatures (64 bytes and DER) for every curve, and refusals: another key, another text, a key not in `authentication`/`assertionMethod`, a `kid` of another DID, unsupported `alg` and `crit`, private JWKs, X25519 keys. `packages/browser/test/didProvider.test.ts` runs the shared identity-proof contract suite for did:key, did:jwk, did:web (JWS, file and service) and did:dht (a record signed and served by a stubbed relay), and checks did:web resolution: redirects, oversize documents, private addresses, a document for another DID. The e2e suite adds a did:key proof signed in the test and a did:web proof against a routed HTTPS stub, both shared with a contact who sees them verified.

## References

[WISP 300](300-peer-proofs.md), [W3C DID Core 1.0](https://www.w3.org/TR/did-core/), [did:key](https://w3c-ccg.github.io/did-key-spec/), [did:jwk](https://github.com/quartzjer/did-jwk/blob/main/spec.md), [did:web](https://w3c-ccg.github.io/did-method-web/), [did:dht](https://did-dht.com/), [RFC 7515 (JWS)](https://www.rfc-editor.org/rfc/rfc7515), [RFC 7797](https://www.rfc-editor.org/rfc/rfc7797), [RFC 8037](https://www.rfc-editor.org/rfc/rfc8037), [RFC 8812](https://www.rfc-editor.org/rfc/rfc8812), [Multicodec table](https://github.com/multiformats/multicodec/blob/master/table.csv).

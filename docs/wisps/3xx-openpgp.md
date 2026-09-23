# WISP 3xx — OpenPGP

| Field | Value |
|---|---|
| Number assignment | 3xx; planned, number to be defined |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-23 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [300](300-peer-proofs.md) |
| Implementation | Provider `openpgp` in the identity-proof registry; see [Implementation](#implementation) |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Scope

An optional proof that a participant controls an OpenPGP key ([RFC 9580](https://www.rfc-editor.org/rfc/rfc9580.html), and the [RFC 4880](https://www.rfc-editor.org/rfc/rfc4880.html) v4 keys people already have). The participant signs a Ghostly statement with their own tooling — `gpg --clearsign`, or `gpg --detach-sign --armor` — and gives the result and their public key to their app. Ghostly never holds the secret key, so the same flow works when the key lives on a YubiKey or another OpenPGP card: gpg asks for the card's PIN (and a touch, when the card's policy wants one).

Like every proof under [300](300-peer-proofs.md), it is optional. The person signs **once**: a binding by which their OpenPGP key authorizes a Ghostly proof key (a fresh key per proof, kept in the profile) for a validity period. Each chat then receives a presentation that the app signs with the proof key, bound to that chat, that contact and a fresh challenge — contract code shared by every provider, not part of this document. The person decides per chat whether to present the identity; nothing is re-signed with the OpenPGP key.

## Statement

What is signed is the binding statement defined by the proofs contract ([`PROOFS.md`](../../packages/browser/src/proofs/PROOFS.md)), as plain text. For OpenPGP it MUST be signable by `gpg --clearsign` without alteration: printable ASCII and line feeds only, no trailing whitespace on any line, no line starting with `-` (which clearsigning would dash-escape), and no final line feed. The app refuses to offer a statement that breaks this.

The signed bytes are the statement itself, or the statement followed by one `LF` or `CRLF` — what a detached signature over a saved file covers. A verifier tries exactly these three and nothing else. A clearsigned text is compared with the statement after the normalization clearsigning applies (trailing whitespace dropped, line endings unified); any other difference is refused before any signature is checked.

## Evidence

```json
{ "scheme": "openpgp/1", "key": "<base64url>", "signature": "<base64url>" }
```

- `signature`: exactly one OpenPGP signature packet (binary, then base64url), of type 0x00 (binary) or 0x01 (text). A clearsigned text is reduced to its signature packet; a message with several signatures is refused.
- `key`: a minimal transferable public key — the primary key, its revocation and direct-key signatures, each valid user ID with its self-certifications only, and the one subkey that signed with its binding signatures. Third-party certifications, user attributes (photos) and unused subkeys are removed before sharing.

No other fields are allowed. Limits, enforced before parsing: 1.5 KiB for the signature packet and 9 KiB for the minimal key, so the JSON fits the contract's 16 KiB of evidence (an RSA-4096 key with eight user IDs does); 16 user IDs of at most 256 bytes. Pasted input is bounded too: 16 KiB for a signature, 256 KiB for a public key (a flooded key is refused, not trimmed).

## Verification

A verifier (the contact's app, locally, fetching nothing) MUST refuse the proof unless all of the following hold:

1. The key parses as exactly one public key, of version 4 or 6. v3 keys and the LibrePGP v5 format are refused. A private key is refused without being echoed.
2. The primary key and the key that signed use an allowed algorithm: Ed25519 (both the RFC 9580 algorithm 27 and the legacy EdDSA form), Ed448, ECDSA on P-256, P-384, P-521 or brainpoolP256r1/P384r1/P512r1, or RSA with a modulus of at least 2048 bits. DSA, ElGamal and secp256k1 are refused.
3. The signature's hash is SHA-256, SHA-384, SHA-512, SHA-224, SHA3-256 or SHA3-512. SHA-1, MD5 and RIPEMD-160 are refused. Self-signatures on the key may still use SHA-1, because older keys carry them; MD5 and RIPEMD-160 are refused there too.
4. The key's primary fingerprint is the one the statement names (the statement's external identity); a valid signature by any other key is refused.
5. The signature's issuer (key ID, and the issuer fingerprint subpacket when present) is the primary key or one of its subkeys.
6. That signing key is valid **both at the signature's creation time and now**: the primary key is not expired or revoked; a subkey has a valid binding signature with the signing flag and a valid embedded primary-key binding (back-)signature, and is itself not expired or revoked.
7. Revocations follow RFC 9580: a hard revocation (no reason, or "compromised") voids every signature of the key, including earlier ones; a soft one ("superseded", "retired") voids the key from its date.
8. The signature is not dated more than 5 minutes after now, nor more than 5 minutes before the start of the binding's validity.
9. The signature verifies over one of the three byte strings above.

Because the binding is long-lived and re-used across chats, checks 6 and 7 run again at every verification, not only when it was made: a binding whose key expired or was revoked since stops verifying. The proof records the primary fingerprint, the signing (sub)key fingerprint, the algorithm, the key's expiry (the earlier of the primary key's and the subkey's) and the valid user IDs, and is re-checked against the current time whenever it is displayed as verified.

## What it shows, and what it does not

The UI shows the fingerprint and the key's first valid user ID (the verifier records them all), and MUST say, wherever a user ID appears, that anyone can put any name or email on their own key: holding the key does not prove that a user ID's name or email belongs to the person.

**keys.openpgp.org.** The app contacts [keys.openpgp.org](https://keys.openpgp.org) only when the person asks, and says beforehand that doing so tells that server which key or email is being looked up. That keyserver publishes a user ID only after its email owner confirmed it, so an email present in its copy of the key MAY be shown as confirmed — labelled as the keyserver's check, never Ghostly's, and never extended to the name. Because a contact cannot check a claim that the other side fetched a key from there, the label is only ever shown for a lookup made by the app showing it: the person's own, while preparing the proof, or the contact's own, from the proof's details. The contact's lookup also reveals a revocation or new expiry published there since.

**Revocation freshness.** The shared key is the prover's copy. A prover can present a copy from before a revocation; nothing but a fresh lookup (above) or re-proving reveals it. The binding's validity period bounds how long such a copy can be presented, and a verifier treats "verified" as "verified with the key as presented".

## Conformance

The implementation's vectors (`packages/browser/test/vectors/openpgp/`) are generated by GnuPG 2.2 with `generate.sh`; the RFC 9580 v6 case is generated by OpenPGP.js, since GnuPG does not produce v6 keys. Accepted: a clearsigned statement from a certify-only Ed25519 primary with an Ed25519 signing subkey (the smartcard layout); binary and text-mode detached signatures; RSA 3072; ECDSA P-256 and brainpoolP256r1; a v6 Ed25519 key. Refused: another statement; an edited statement; a signature by another key than the one given; an expired key; a hard-revoked key, including for a signature made before the revocation; a soft-revoked subkey after its revocation (and accepted before it); an expired subkey; RSA 1024, DSA and secp256k1; SHA-1; an inline-signed message; two signers; a signature dated in the future or before the binding's validity starts; a valid signature by a key other than the one the statement names; a private key in either field; oversized or malformed evidence; evidence whose key or signature was swapped.

## Implementation

`packages/browser/src/proofs/providers/openpgp.ts` is the provider under the shared contract ([`PROOFS.md`](../../packages/browser/src/proofs/PROOFS.md)); `packages/browser/src/proofs/openpgp.ts` is the verifier and evidence format.

- **Subject**: the primary key's fingerprint, uppercase hex; a short key ID is refused.
- **Signers** (both `external-tool`): *gpg*, with copyable commands that save the one-line statement, clearsign it with `--local-user <fingerprint>` and export the minimal public key; one paste holds both blocks, and nothing is looked up. *gpg, key from keys.openpgp.org* signs the same way and then fetches the public key by fingerprint from keys.openpgp.org; its description says so, and it is only used when the person picks it.
- **What `verify` returns**: the fingerprint, `source` naming the algorithm and whether a signing subkey signed, `expiresAt` when the key or subkey expires before the binding, and `display.name` = the key's first valid user ID, whose `display.source` is the warning that its holder wrote it and it proves no name or email.
- **`lookupDisplay`** (on request): the first email keys.openpgp.org confirmed on this key, labelled as that keyserver's check; a revocation held there is reported as an error.
- **Bundle**: the provider module is small; OpenPGP.js is imported only through `loadOpenPgp()`. The library is [OpenPGP.js](https://openpgpjs.org) 6, which has had two complete security audits by Cure53, is maintained by Proton, and already implementing both RFCs, subkey binding and back-signature checks, revocation semantics and algorithm policy. A verifier written for Ghostly alone would be smaller but unaudited, for a parser of untrusted input. Its "lightweight" build is loaded only when an OpenPGP proof is opened: about 233 KB minified (64 KB gzipped), plus a 46 KB curve chunk loaded for ECDSA keys only. No other page pays for it.

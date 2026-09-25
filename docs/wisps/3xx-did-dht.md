# WISP 3xx: Profile DID (did:dht)

| Field | Value |
|---|---|
| Number assignment | 3xx; planned, number to be defined |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-25 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [01](01-ghost-core.md), [02](02-peer-keys.md), [04](04-profiles.md), [05](05-backups.md), [300](300-peer-proofs.md) |
| Implementation | Experimental, web, desktop and extension: `packages/core/src/didDht.ts`, `packages/browser/src/engine/did.ts`, `src/components/identities/PublicDid.tsx`, Desktop `publish_signed_packet` |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Purpose

Every Ghostly profile has a W3C [Decentralized Identifier](https://www.w3.org/TR/did-core/) of the [did:dht](https://did-dht.com) method (DIF, specification version 0): a DID document written as DNS records into the Pkarr packet of an Ed25519 key and stored in the Mainline DHT as a BEP44 mutable item, the same mechanism Ghostly uses for chats ([01](01-ghost-core.md)). Any did:dht resolver reads it, with no Ghostly server involved.

The DID is one identifier a person can give out in public. Chats never use it. By default its document says nothing but its key; the person may list some of their identities in it, one switch at a time.

## The key

Ghostly has no profile-wide key pair: every chat has its own participation key ([02](02-peer-keys.md)), and a profile is not a protocol identity ([04](04-profiles.md)). A DID over a chat's key would publish that key to everyone and tie that chat to the DID. So each profile has a **DID key of its own**:

- an Ed25519 key made the first time the profile's peer starts, and never changed (did:dht identity keys cannot rotate);
- kept in the profile's peer database (the settings record `profileDid`), its seed sealed with a device key the way proof-key seeds are ([300](300-peer-proofs.md));
- used for nothing but this DID: never for a chat, a signal, a proof or a group;
- carried by a profile backup ([05](05-backups.md)), so a restored profile keeps its DID; clearing the profile's data or removing the profile ends it (the next start makes a new DID, and the old document leaves the DHT within hours).

A key has exactly one Pkarr packet: a second packet under the same key replaces the first. Nothing else publishes under the DID key today, so its packet holds the DID document alone. Records added under this key in the future MUST go into the same signed packet as the document, and the whole packet MUST fit 1000 bytes; the encoder takes such records and checks the combined size.

## The document

Without listed identities the document is the key alone, as the did:dht Create step makes it (the specification's vector 1 has this exact shape):

```json
{
  "id": "did:dht:<z-base-32 key>",
  "verificationMethod": [{
    "id": "did:dht:<key>#0", "type": "JsonWebKey", "controller": "did:dht:<key>",
    "publicKeyJwk": { "kty": "OKP", "crv": "Ed25519", "x": "<base64url>", "alg": "EdDSA", "kid": "0" }
  }],
  "authentication": ["did:dht:<key>#0"],
  "assertionMethod": ["did:dht:<key>#0"],
  "capabilityInvocation": ["did:dht:<key>#0"],
  "capabilityDelegation": ["did:dht:<key>#0"]
}
```

The four relationships are the method's requirement for the identity key. There is no `service`, no `alsoKnownAs`, no `controller`, no type index and no gateway record by default. Ghostly shows identities to one contact at a time ([300](300-peer-proofs.md)); a public DID document would show them to everyone.

## Listing identities (opt in)

The Ghostly card's details (Identities, Yours) show the DID with Copy and a QR code, whether it is published, and a switch per identity of the profile, all off. A switch that is on adds that identity to the document's `alsoKnownAs`, in the order the switches were turned on, under a warning that the document is public to everyone and that some resolvers keep copies after an identity is taken out.

An identity can be listed when its proof is in the profile, verified and current, and its provider gives the verified subject a URI (`publicUri` in the [provider contract](../../packages/browser/src/proofs/PROOFS.md)):

| Provider | URI in `alsoKnownAs` |
|---|---|
| `nostr` | `nostr:<npub>` ([NIP-21](https://github.com/nostr-protocol/nips/blob/master/21.md)) |
| `domain` | `https://<domain>` |
| `openpgp` | `openpgp4fpr:<fingerprint>` |
| `bitcoin` | `bitcoin:<address>` ([BIP-21](https://github.com/bitcoin/bips/blob/master/bip-0021.mediawiki)) |
| `ssh-github`, `ssh-gitlab` | `https://github.com/<login>`, `https://gitlab.com/<login>` |
| `ssh` (a bare key), `oidc` | none: not listable |

A URI never contains a comma (did:dht separates the list with commas). An identity whose proof expired stays chosen but leaves the document until it is renewed; a renewal is a new proof, listed again by hand. A removed proof leaves the list. A switch that would push the packet past 1000 bytes is refused with a message.

A listing is the DID controller's claim, not a proof: the listed identity did not sign anything about the DID. Anyone who needs proof checks the identity itself (a Ghostly identity proof shared in a chat, the domain's record, the Nostr key's signature).

## Encoding

- did:dht version 0. The root record `_did.<key>.` (TXT, `v=0;vm=k0;auth=k0;asm=k0;inv=k0;del=k0`), the identity key `_k0._did.` (TXT, `t=0;k=<base64url>`), and when identities are listed `_aka._did.` (TXT, the URIs joined by commas). TTL 7200. The Authoritative Answer flag is set and names are compressed ([RFC 1035](https://datatracker.ietf.org/doc/html/rfc1035) 4.1.4).
- Record order: `_aka._did.`, the key records, then the root record (gateway NS records last if any). The specification gives record sets, not an order; `@web5/dids` resolves the root record's references in packet order and returns empty relationships when the root record comes first, so the root record follows the records it names.
- The BEP44 sequence number is the UNIX time in **seconds**, as did:dht requires (Ghostly's chat records use microseconds), strictly increasing: the later of now and the last one plus one.
- The client signs the packet. The web app and the extension put it on their Pkarr relays; Desktop hands the signed payload to its Rust Pkarr client, which publishes it byte for byte to the DHT and its relays.

## Publishing

- Only while the profile is online. The first publish runs 15 seconds after the peer starts, after the chats' first requests; a change to the document is published 2 seconds later (a few switches in a row make one publish), signed with a new sequence number.
- The same signed packet is put again every hour while the app runs: Mainline keeps a mutable item for about two hours, and an identical item refreshes it without an update (did:dht asks for infrequent updates). A failed publish is tried again after 5 minutes. After a restart an unchanged document is put again as it was.
- Budget: on relays it spends the background share of the per-relay request budget: one PUT per relay per hour, and no reads. Measured with the `pkarr-relay` 2.0.2 binary: an identical packet again answers 204, a newer one 204, an older one 409 ("packet is not the most recent").

## Resolution

`resolveDidDht(did, { fetch, relays, signal })` in `@ghostly/core` reads any did:dht, bounded and strict:

- The DID is exactly `did:dht:` and 52 canonical z-base-32 characters of an Ed25519 point: no path, query or fragment.
- One GET `<relay>/<key>` at a time (Pkarr relays and did:dht gateways answer the same request), the next relay only after a 404, an error or a packet that does not check out; at most 1072 bytes; the BEP44 signature is checked against the DID's key.
- The root record is exactly `_did.<key>`; other records are `_<name>._did` or, as Pkarr clients that append the key write them, `_<name>._did.<key>`. Records of the key that are not did:dht records are ignored, and so are did:dht records this version does not know (`_prv`).
- Version 0 only; `vm` lists `k0`, which is type 0 and the DID's own key; every reference names a listed key or service; keys of types 0 to 3 are checked as curve points, and are named by `id=` or their [RFC 7638](https://datatracker.ietf.org/doc/html/rfc7638) thumbprint; service endpoints, `alsoKnownAs` entries and controllers are URIs or DIDs; each record and property appears once. Anything else is refused as malformed.
- A root record reading `deactivated` resolves with `deactivated: true` in the metadata and a document holding the id alone. The metadata's `versionId` is the sequence number and `updated` its date.

Errors say what happened, for a person: not a did:dht, nothing published, not signed by the DID's key, malformed, no relay answered. Contacts' DIDs and the DID identity providers use this resolver.

## Privacy

- The DID's key is new and appears in no chat, so publishing it reveals nothing about chats or contacts. Relays and DHT nodes see the publishing address beside the DID key, as they see chat keys; profiles on one device share that address ([04](04-profiles.md)).
- Whoever has the DID can resolve it; they learn only what the person listed.
- The document is published automatically while online, with the key alone. Listing is the only thing that makes it say anything about the person.

## Security considerations

- The identity key cannot rotate. A DID whose key leaked is replaced by a new profile's DID; the specification's `_prv` link from a new DID to an old one is not implemented.
- The seed is sealed with a device key stored beside it: that protects it from casual inspection of the database, not from someone who holds the database. Profile backups carry it encrypted with the backup passphrase.
- `alsoKnownAs` is self-asserted (see Listing identities).

## Conformance

A client MUST publish a profile's DID only under that profile's DID key, never under a chat's participation key or a proof key; MUST keep `alsoKnownAs` empty unless the person listed identities, and SHOULD warn before the first one; MUST keep one packet per key within 1000 bytes; MUST use a sequence number in seconds that only increases; SHOULD refresh the packet at least every two hours while online. A resolver MUST verify the BEP44 signature against the DID's key and MUST refuse a malformed document rather than guess.

## Test evidence

- The specification's official vectors 1 to 3 (`decentralized-identity/did-dht` commit `3fa9536`), both ways, plus strict-parsing refusals and resolution: `packages/core/test/didDht.test.ts`.
- Interoperability with `@web5/dids` 1.2.0 both ways (Ghostly publishes and web5 resolves; web5 publishes and Ghostly resolves), through a relay in the test process and, with `GHOSTLY_PKARR_RELAY`, the `pkarr-relay` 2.0.2 binary: `packages/browser/test/didDhtInterop.test.ts`.
- Desktop publishes a packet the TypeScript peer signed, byte for byte: `src-tauri/src/commands.rs`.
- Engine (key, publish, hourly refresh, listing, removal, expiry, offline, failure): `packages/browser/test/profileDid.test.ts`; UI: `src/test/identities/publicDid.test.tsx`; end to end, the web app publishes and `@web5/dids` resolves the key alone, then a listed Nostr identity, then without it: `e2e/web/did-dht.spec.ts`.

## Open decisions

- A switch to not publish the DID at all.
- Services (a Ghostly contact entry point, for example) stay out: one would give everyone a way to reach the profile.
- Key rotation through `_prv`; type indexing and authoritative gateways are not used.
- A backup restored as a new profile beside its original carries the same DID key: both profiles then publish under it, and the packet with the lower sequence number is refused by relays until one of them changes its document.

## References

- [did:dht Method Specification](https://did-dht.com) and its [registry](https://did-dht.com/registry/), Decentralized Identity Foundation.
- [Decentralized Identifiers (DIDs) v1.0](https://www.w3.org/TR/did-core/), W3C.
- [BEP 44](https://www.bittorrent.org/beps/bep_0044.html), storing arbitrary data in the DHT; [Pkarr](https://pkarr.org).
- [RFC 1035](https://datatracker.ietf.org/doc/html/rfc1035), [RFC 7638](https://datatracker.ietf.org/doc/html/rfc7638).

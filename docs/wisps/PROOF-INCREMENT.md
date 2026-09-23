# Optional peer proofs — implementation increment

> Release decision (2026-09-21): external identity proofs and external profile lookup are deferred. This release exposes only Ghostly participation identity. Nostr, Pubky, Keet, imports and Ring UI are disabled; previous experiments and stored data are preserved for future work. Descriptions below are historical/research, not available release features.

2026-09-20. Experimental implementation of Nostr and authorized local-import profiles for WISP 300–303; all WISPs remain Draft. This is not an independent interoperability certification or a security audit.

## Identity and consent

**Ghostly identity** is the participation key already pinned for this conversation. External accounts are optional, do not replace channel authentication, and are not used to sign chat messages. The identity dialog is conversation-scoped. Only an explicit **Sign and share with this contact** action requests an external public key/signature. Neither a saved proof nor reconnecting automatically shares it with another contact.

An external public key can correlate conversations in which the user elects to share it. Verification establishes control at signing time, not civil identity, trustworthiness or anonymity. Nostr remains external-signer only. The subsequently authorized local import experiment accepts Pubky 32-byte hex secrets and Keet-compatible 24-word English mnemonics; see the local profile below. Bunker connection URLs stay in UI memory and are cleared on success/close; ephemeral NIP-46 client communication keys are distinct from the external identity and discarded on completion/cancellation. No claim of perfect memory erasure is made for JavaScript.

## Exact experimental Nostr profile

Capability `proof-nostr/1` is included in the participation-signed negotiation only when the engine installs its proof receiver. Both peers must be ready and support it. Legacy/no-proof peers remain usable for ordinary chat.

The canonical UTF-8 JSON array signed as Nostr event content is:

```
["ghostly-peer-proof",1,"control-of-external-key","nostr",externalKey,
 subjectParticipationZ32,audienceParticipationZ32,conversationHash,
 sessionTranscriptHash,challengeBase64url,issuedAtSeconds,expiresAtSeconds]
```

- `externalKey`: 32-byte lowercase-hex Nostr public key, verified using BIP-340 Schnorr.
- Participation/audience: the current authenticated participation keys, not rendezvous, transport or signer-connection keys.
- Conversation hash: SHA-256 of UTF-8 JSON `["ghostly-conversation",1,sortedRendezvousZ32Keys]`.
- Session hash: the existing `PairedSession` authenticated transcript digest, including transport binding and negotiated offers. A signature still pending when the transport/session changes needs a new challenge. Accepted evidence survives a transport change as historical evidence for the same conversation/participations, not proof of current possession in the new session.
- Challenge: verifier-generated 32 random bytes, base64url without padding. Fresh for 300 seconds; future clock tolerance 30 seconds. Signed lifetime exactly 86400 seconds. Bad system clocks fail closed.
- Event kind 30078 is existing NIP-78 application-specific data; no new Nostr kind/NIP is claimed. `created_at` equals issuedAt; exact tags are `[["d","ghostly-peer-proof/1:"+conversationHash],["expiration",String(expiresAt)]]`. No extra tags/content accepted.
- Event ID is independently recomputed from NIP-01 canonical event serialization. ID, pubkey, exact template and Schnorr signature are verified before either side persists a successful result. Merely returning a public key is insufficient.

Frames over the authenticated paired application channel: `proof-request` (random request ID, adapter, externalKey), `proof-challenge` (request ID, exact challenge), `proof-present` (challenge, signed event), `proof-accepted` (event ID), `proof-withdraw` and `proof-withdrawn` (event ID). This private application exchange does not publish the proof to a Nostr relay. NIP-46 uses encrypted signer-control events on the user's explicitly selected relay(s).

## Persistence and failure rules

The verifier commits each challenge before sending it. Challenge consumption and accepted evidence are one IndexedDB read-transform-write transaction. Unknown/consumed nonces are rejected, including after restart; removing a consumed nonce never permits acceptance of an unsolicited nonce. Incoming challenges are bounded to eight unexpired entries; one outgoing preparation and one current record per adapter/direction are retained. Wire proof frames are limited to 8192 UTF-16 code units, within the existing paired frame ceiling.

The sender verifies first, persists a pending record, sends, and marks accepted only after the authenticated peer's acknowledgement. Lost acceptance acknowledgement remains **acceptance not confirmed**; it never becomes a false success. The user may explicitly create a fresh proof. This increment does not retry or publish proofs automatically.

Withdrawal is a participation-authenticated conversation action, not revocation of the external account. It is saved locally as pending before sending; pending withdrawal notifications retry on reconnect to that same participation/conversation and finish only after peer acknowledgement. Remote copies cannot be erased. There is no universal Nostr revocation lookup; the UI shows signature verification time, signed expiry, withdrawn/expired/pending states and mismatched participation keys separately.

Proof failures do not replace pins, clear history, weaken transport policy, or disable ordinary chat. Unrelated conversation updates use atomic field patches so they cannot roll back the proof replay ledger.

## Signer/runtime matrix

| Flow | Implemented | Actual validation | Remaining limits |
|---|---|---|---|
| Default Ghostly identity, no external proof | Yes | Existing paired chat + updated native chats | No external account necessary |
| NIP-46 bunker signer | Yes | Real local WebSocket/NIP-44 exchange with separate ephemeral signer/user keys; two native Tauri UIs over HyperDHT and web → native over WebRTC accepted scoped proofs; withdrawal acknowledged both native sides | Fixture is not an independent commercial signer; no user's real account was used |
| NIP-07 injected browser signer | Yes, availability detected in current window | API fixture tests for refusal and late cancellation; browser/extension builds | No installed real NIP-07 extension was exercised; a signer injected into ordinary websites is not assumed available inside another extension or native WebView |
| Pubky local import | Experimental | SDK key conversion, real Ed25519 verification, native peer UI | Not Pubky Ring or homeserver login |
| Keet-compatible local import | Experimental | SDK derivation/attestData/verify and browser/native compatibility regression | Not evidence of an existing Keet app account |
| Multiple proofs | One record per adapter/direction | Coexistence and independent withdrawal tests | Same Ghostly implementation; no independent-client certification |

Nostr signer requests time out after two minutes; peer challenge requests after 15 seconds. Cancellation ignores late signer results. The app never auto-opens signer auth URLs and only displays validated HTTPS approval links. Bunker input accepts 1–3 secure WebSocket relays; insecure WebSocket is limited to loopback for isolated development tests. It does not resolve NIP-05 or silently switch relays. Signer permission is restricted to `sign_event:30078`. Accounts already configured at a signer remain entirely external.

## External Pubky signer feasibility (historical no-import scope)

Inspected Ring `inputParser.ts`, `authAction.ts`, `sessionAction.ts`, and Pubky core AuthToken/Grant/JWS definitions. Ring exposes sign-in/sign-up, grant and session flows; session returns public identity plus session/grant credentials. AuthToken signs authorization capabilities; Grant signs issuer/client/capabilities/client proof-of-possession key/ID/time. These interfaces do not provide a documented arbitrary statement-signing request covering the Ghostly verifier nonce, audience and conversation.

Forwarding bearer/session material to a peer is not a safe replacement. Encoding a challenge into a fabricated permission path would conflate identity proof with authorization and is not implemented. No Ring capability or arbitrary Ring signing API is claimed. The separately authorized local proof below does not remove this external-signer blocker. To enable this adapter, supply an actual external Pubky signer API supporting the exact challenge statement, or separately design/review an explicit delegated proof protocol with appropriate permission and revocation semantics. Neither needs the user's private key imported into Ghostly.

## External Keet signer feasibility (historical no-import scope)

The Pear tutorial derives a mnemonic-backed identity inside an application worker, bootstraps a device, and attests data. `keet-identity-key` implements those primitives and verification. The inspected material does not document an external request-signature interface to the existing Keet app/account. Generating another compatible identity would not prove that account; importing its mnemonic was outside the original no-import scope. The later explicit local-import authorization enables compatible key proofs only. A supported external Keet signer/attestation bridge remains necessary to claim that integration.

## Source revisions

- Nostr NIPs at `46f8e9501c32f506d07b5de67f414d4f92928cd5`: [01](https://github.com/nostr-protocol/nips/blob/46f8e9501c32f506d07b5de67f414d4f92928cd5/01.md), [102](https://github.com/nostr-protocol/nips/blob/46f8e9501c32f506d07b5de67f414d4f92928cd5/07.md), [46](https://github.com/nostr-protocol/nips/blob/46f8e9501c32f506d07b5de67f414d4f92928cd5/46.md), [78](https://github.com/nostr-protocol/nips/blob/46f8e9501c32f506d07b5de67f414d4f92928cd5/78.md). Runtime SDK pinned to `nostr-tools` 2.25.2; core independently checks the event with its existing noble Schnorr primitive.
- [Pubky Ring](https://github.com/pubky/pubky-ring/tree/f142436883b4f41a599da37993a9635225f008fa), [Pubky core auth](https://github.com/pubky/pubky-core/tree/ce5bf6b7ec89f4d14d39c1c49b6fd8adb625785d/pubky-common/src/auth).
- [Pear tutorial](https://docs.pears.com/p2p/how-to/manage-identity/add-keet-identity-to-a-chat-app/) inspected 2026-09-20; [identity library](https://github.com/holepunchto/keet-identity-key/tree/85c8e08eedc4269a2612d8eaacf4e258b6814b07).


## Authorized local-import experiment

The user subsequently explicitly authorized simulated imports with locally generated disposable secrets. The input starts empty, is masked and is never sent through RPC, the engine, transport, storage, logs or URLs. Only public evidence leaves the renderer. Closing, changing adapter and completing a signature clear the field and signer references; mutable secret buffers are wiped where available. JavaScript strings, SDK/WASM copies and runtime garbage collection prevent a guarantee of perfect zeroization. Generate disposable test key requires an explicit click and does not share anything by itself.

Separate signed capabilities are `proof-pubky-import/1` and `proof-keet-import/1`. They use the same nonce, participation, audience, conversation, session and expiry statement as Nostr, substituting the adapter and canonical external public key. Evidence ID is SHA-256 of JSON `[scheme,statement,base64urlSignature]`. No imported secret is used as the participation or transport key.

- Pubky: pinned `@synonymdev/pubky` 0.12.0 `Keypair.fromSecret` accepts exactly 32 bytes; its z32 public key is checked against standard Ed25519 derivation. Because the SDK has no arbitrary-message signing API, noble Ed25519 signs the exact UTF-8 statement with that seed. No Ring, auth token, grant or homeserver session is used.
- Keet: pinned `keet-identity-key` 3.2.0 accepts a validated 24-word English BIP39 mnemonic with no extra passphrase. Its official identity derivation and `attestData`/`verify` produce a root-only v1 DataAttestation. The verifier requires exactly 107 bytes, version 1, empty chain and data flag 1 before SDK decoding. The public key is 32-byte lowercase hex. This proves control of a compatible key, not membership, a nickname or an existing Keet app account.
- Browser compatibility: checked-in patch-package patches replace a Buffer-only integer write with b4a; use WebCrypto PBKDF2-HMAC-SHA512 (2048 iterations, 64-byte output, SDK salt) where sodium-javascript lacks the native extension; and use pinned noble HMAC-SHA512 where incremental sodium SHA-512 is unavailable. Tests compare native and actual Vite browser-bundled identity derivation and verify attestations both ways. These are explicit compatibility changes, not a new Keet signature scheme.
- Bundled Pubky WASM requires CSP `wasm-unsafe-eval` in desktop and extension; no generic `unsafe-eval` or remote script source is added. SDKs load lazily but add approximately 2.6 MB Pubky and 1.6 MB Keet minified chunks before gzip. This experimental size cost remains.

See the latest local validation section for observed peer UI results and exact remaining limitations. No actual user account secret was accessed or requested.

## Compact identity UI and public profiles

The subsequent [identity presentation and local public-profile increment](PUBLIC-PROFILES.md) adds compact ecosystem cards, status badges and progressive disclosure. It can display public Nostr/Pubky metadata for a presented key; those self-described names/photos never replace proof verification or participation pins. Keet-compatible imports do not imply an existing Keet profile. The protocol and proof formats above remain unchanged.


### Modified Ring follow-up

A separate `pubky-ring/1` experimental adapter now implements an identity-only delegation with fresh client proof of possession and a ten-minute conversation binding. It requires a locally modified Ring, not the unchanged official app. It does not export or forward a homeserver Grant/session secret. Local Pubky imports remain available as Advanced; Nostr/Keet and Ghostly participation are unchanged. See [WISP11](302-pubky.md), [source and build provenance](../../integrations/pubky-ring/README.md), and the final validation entry for what was actually tested.

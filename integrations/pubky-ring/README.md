# Experimental Pubky Ring extension

This is a **modified Ring**, not support in the unchanged official app. Base:
https://github.com/pubky/pubky-ring/commit/f142436883b4f41a599da37993a9635225f008fa (0.0.32), React Native 0.86, native Pubky SDK 0.14.0.

The official app's Grant API authorizes homeserver resources. It does not provide explicit consent for a Ghostly conversation proof, expose a public grant plus domain-separated proof operation through JS SDK 0.12, or give a peer a public revocation-status endpoint. Grant secrets and login approval are not peer identity evidence. This extension consequently uses a **separate identity-only authorization**, not a `pubky-grant`, session export or fabricated resource capability.

Ring signs an Ed25519 JWS with type `ghostly-pubky-identity-delegation/1`, delegating only the SHA-256 digest of one exact Ghostly challenge to the temporary client public key. Ghostly signs a separate domain-separated proof of possession binding that authorization and the entire challenge. Both signatures are checked by the contact. The challenge includes both participation keys, conversation, current connection/session, random verifier nonce and timestamps. Lifetime is exactly ten minutes; pending approval lasts three minutes. No renewal, resource access, public post or login credential is involved.

This is a time-bounded signed statement, not an ongoing authorization. Ring's homeserver session revocation does not revoke it. Ghostly's independent authenticated withdrawal stops presentation here; remote copies cannot be recalled. A verifier must not claim current account access or identity ownership indefinitely. Expiry/withdrawal removes the associated public profile from presentation. Root key remains inside Ring; only public evidence crosses the peer connection. Temporary Ghostly signer/relay keys are memory-only and discarded on success/cancel/timeout/restart. Backgrounding the live renderer is supported; restart starts a new request.

Three encrypted messages use separate SHA-256-derived inbox addresses on `https://httprelay.pubky.app/inbox`: identity selection, peer challenge, approval. AES-256-GCM with fresh random 96-bit nonces and slot-specific associated data protects contents; the ephemeral channel secret is in the private QR/deeplink only. HTTPS relay availability and metadata visibility are limitations. QR access is a pairing capability: do not share it. Identity choice intentionally reveals the selected public key to the requesting Ghostly before final approval. Ring then displays participant keys and a conversation comparison code and requires explicit approval even when ordinary Ring auto-auth is enabled.

## Local build

A reproduction script/patch is supplied alongside this file. Use a separate clone; never patch a personal installed Ring or reuse a personal simulator/keychain. Copy `packages/core/src/pubkyRing.ts` and `bytes.ts` verbatim into the patched Ring's `src/ghostly/`. The overlay uses the existing Ring key generation and keychain only after user selection/approval. Test identity creation is an explicit button; no static seed is committed.

Install package additions pinned in the patch, run Yarn and CocoaPods, then build `pubkyring.xcworkspace`, scheme `pubkyring`, Release, SDK iphonesimulator. Use bundle identifier `app.ghostly.ringtest`, display name `Ring Ghostly Test`. The Ghostly UI presents the modified-build limitation before its Connect action and keeps the prior local import behind Advanced.

No independent audit or official interoperability certification is claimed. Native E2E results and remaining limitations are recorded in docs/wisps/VALIDATION.md after execution.

## Correct app and input routing (2026-09-21 fix)

The user reported **Unrecognized format in the official Ring on their phone**. That build has no Ghostly identity-proof action. This cannot be fixed in the installed official phone app by changing a QR payload into a fake session or login proof.

Ghostly now generates **`ghostlyring://proof`**, a scheme registered by Ring Ghostly Test, rather than an ambiguous `pubkyring://` link. Desktop UI says developer preview and names the required app before starting; it offers a link to paste in the simulator. A QR is hidden in an explicit modified-build disclosure. The desktop does not present an “Open Ring” link that would target an unrelated installed app.

All modified-Ring inputs (cold/warm deep link, AuthScanner, AddPubkyScanner, MigrateScanner and SelectPubky) dispatch through the same memory-only `ringInput.ts` **before** the generic key/import/session parser. The shared `ringLink.ts` is also used by Ghostly's actual URL generator. It accepts canonical input, surrounding clipboard whitespace, a single whole-URI percent-encoding, and an optional slash before the query. Legacy `pubkyring://ghostly-proof` input remains recognized in the modified build for manual QR/paste compatibility; new requests never use that scheme. Duplicate/unknown fields, malformed keys, unsupported versions, fragments and expired requests fail closed with actionable messages. They do not fall back to key import.

The approval modal mounts only after the existing Ring terms state is accepted. Requests arriving earlier remain in memory for at most three minutes and cannot approve anything; no consent state is changed by the patch. A fresh request is needed after expiry.

To reproduce locally: use the dedicated simulator and **Ring Ghostly Test**, complete the normal Ring onboarding/terms personally or with explicit approval, then start a **Ring Ghostly Test connection** in the Ghostly conversation. Copy the connection link and paste in the test app's scanner. Do not scan it using official Pubky Ring on a phone. No import of the user's real key is needed; the approval screen has an explicit disposable-test-identity action. These directions describe the intended test path, not a claim that the pending native approval E2E has passed.

# Interoperability and conformance plan

This plan is not a test report. No Draft has passed the Final gate merely by being written. Existing tests provide regression evidence for current features; proposed wire profiles need exact encodings, fixtures and independent implementations first.

## Evidence required per profile

Record document revision, implementation/version/commit, dependency versions, platform/runtime, negotiated profile, fixture inputs, expected/actual results and negative cases. Use synthetic keys and private local test contexts. Never publish real invites, seeds, tokens or user history. Pin upstream formats referenced by a profile; a mutable upstream link is not a conformance version.

A positive case exchanges data in both directions. A negative case records the expected rejection and verifies no unauthorized side effect. Transport success is not capability, identity or durable-delivery success. Test independent implementations in addition to cross-platform clients sharing a library.

## Minimum case matrix

| Scope | Positive case | Required failure/recovery cases |
|---|---|---|
| 02 Core | Rust/TypeScript record exchange | Wrong key/signature, bad secretbox, stale/replayed packet, full budget, relay failures |
| 03 Keys / 20 Invite | Pair, confirm intended peer, restart and reconnect with stored participation; read `pair3/`, `pair1/`, `pair2d/` and v0.4 codes as 801 says | Two-joiner race; consumed invite reuse; a newer version (`pair4/`) refused with nothing stored; crash at each commit boundary; expired/revoked invite; lost final confirmation; key loss and rotation |
| 04 Capabilities | Same exact selected versions and limits | No common required version; unknown optional/required extension; conflicting revisions; unavailable runtime permission |
| 100-103 Transports | Same payload semantics on two adapters | Offer races, endpoint substitution, timeouts, bounded retries, policy-prohibited fallback; no common adapter (the chat stays on the DHT and chats); every transport blocked then one unblocked (upgrade without action); native upgrade from layer-0 descriptors with WebRTC blocked |
| 300-303 Proofs | None/one/multiple valid optional proofs | Wrong channel/key/audience, replay, expiry, rotation/revocation, unsupported signer; Keet feasibility first |
| 400 Chat | Bounded bidirectional delivery; first pairing with every stream blocked ends on the DHT; live, DHT, live with nothing lost | Same timestamp, duplicates across paths, out-of-order/gaps, disconnect/restart, no false durable/read receipt, DHT size pressure; different keys on the DHT and stream paths (rejected on both); DHT only on one side; recipient without `dht-text/1` |
| 500 Files | Accepted size and exact bytes | Malicious name, excess/truncated body, duplicate IDs, timeout, cancel, quota and partial cleanup |
| 600 Media | Voice/video and permitted screen modes | Permission denial, stale call, crossed offers, hangup cleanup, unavailable API |
| 700 Local services | Approved target request/response | Path/header/redirect escape, disabled service, inherited credential isolation, body/quota/timeouts |
| 200, 201 and 203 Payments | Authorized supported method with verified outcome | Wrong payee/amount/network, unknown settlement, duplicate retries, lost receipt; no double execution or secret logging |
| 900 Groups | Three independent peers join, exchange and remove one member (one implementation, four browsers, passes) | Concurrent admission/commits, partitions, authority loss, stale/forked epochs, history gaps, unauthorized future keys, bounded resource use; a second implementation remains the interoperability gate |
| 901 Distribution | Common profile delivers authenticated encrypted envelopes | Duplicate/invalid floods, churn, topic leakage, incompatible overlay, removed participant, no implicit bridge |

## Existing useful coverage

- [Protocol and fixtures](../../packages/core/test/protocol.test.ts), [fixtures](../../packages/core/test/fixtures.ts): current record/crypto behavior.
- [Rust interoperability test](../../packages/core/test/interop-rust.test.ts): opt-in live text exchange, skipped without a configured CLI binary. Its existence is not a fresh successful run.
- [File tests](../../packages/core/test/files.test.ts), [HTTP tests](../../packages/core/test/http.test.ts), [call signal tests](../../packages/core/test/callSignal.test.ts), [browser tests](../../packages/browser): current behavior/regressions.
- [E2E guide](../../e2e/README.md): cross-client coverage and desktop platform constraints. Shared TypeScript core does not satisfy independent-implementation evidence for every feature.

## Draft review gates

Before Proposed, every semantic sketch needs exact canonical bytes, message/state limits, replay/clock rules and expected failure outputs. Unresolved cryptographic construction, public ingress or adapter API feasibility blocks the relevant profile. Before Final, publish independent results and security review appropriate to the change; do not infer forward secrecy, anonymity or scale from a library name.

For documentation-only edits, verify all 22 catalogue entries/headers, uniqueness, dependencies, relative links and consistent implementation claims. Runtime changes require their relevant automated and observed app checks, recorded separately with limitations.

## Optional Nostr proof increment (2026-09-20)

The [proof increment](PROOF-INCREMENT.md) now includes explicit experimental local imports for Pubky and Keet-compatible keys, alongside external-signer Nostr. Multiple proofs coexist per conversation. Ghostly participation remains the default. Pubky Ring and existing Keet account signer bridges remain unavailable; local key control is not evidence of those integrations. All WISPs remain Draft; earlier baseline inspections are historical.

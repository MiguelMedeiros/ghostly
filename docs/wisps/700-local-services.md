# WISP 700: Local Services

| Field | Value |
|---|---|
| Candidate number | 700; pending catalogue acceptance, not an official assignment |
| Status | Draft |
| Revision | 0.3 |
| Updated | 2026-09-25 |
| Editors | Ghostly contributors; maintainer review pending |
| Dependencies | [03](03-capabilities.md), [100](100-transports.md) |
| Implementation | Existing HTTP proxy, in every chat (desktop and extension hosts) |

> This is a review draft. Candidate numbers and new wire formats are not registered standards. Normative language describes a candidate requirement, not a shipped guarantee. See the [catalogue](README.md), [implementation evidence](IMPLEMENTATION.md), and [interoperability plan](INTEROP.md).

## Contract and concrete profiles

This document defines common responsibilities and proposed extensions. Exact implemented encodings and runtime limits belong to [701 · HTTP Local Service Profile](701-http-services.md). Supporting a concrete profile does not establish full conformance to this Draft.

## Implemented scope

See the concrete profiles above for current fields, limits, receipt semantics and runtime availability. Contract requirements below are separately reviewable; proposed extensions are not shipped merely because a profile exists.

## Candidate requirements

Preserve the local allowlist, origin/base-path confinement, header stripping and explicit enable/disable behavior across adapters. In the chat session the service frames need a live session and both apps offering `services/1` ([701](701-http-services.md#paired-profile)); a chat on the DHT carries none. Advertising a service cannot add a target or change local authorization. Closing sharing terminates access through Ghostly; it does not necessarily stop the local application. Group membership MUST NOT automatically grant localhost access: require a separately selected service audience and host policy before such a profile is enabled.

HTTP request/response bodies travel outside Core records. Extensions for WebSockets, server-sent events or sustained response streaming must be negotiated; current binary chunk framing is not a promise that the entire proxy streams end to end.

## Compatibility, security and open decisions

Keep the existing service ID and framing rules. Browser redirect handling has a documented limitation: validation can occur after fetch followed a redirect; see PROTOCOL.md. Per-peer sharing policy is implemented in 701; group audiences, stronger in-flight revocation and streaming/upgrades still require separate design and validation. Bridges expose the host to untrusted service content and need an explicit platform threat model.

## Conformance

Test path traversal, alternate URL/header injection, redirects, local credentials isolation, disabled/unknown service, quota/timeouts and revocation. Compare native/extension behavior and document differences rather than calling them identical.

## References

[HTTP core](../../packages/core/src/http.ts), [native local fetch](../../src-tauri/src/local_fetch.rs), [browser limitations](../BROWSER.md), [current HTTP protocol](../PROTOCOL.md).

## Revision log

- 0.3 (2026-09-25): in the chat session, shared apps need `services/1` on both sides and a live session.
- 0.2 (2026-09-25): implementation line: hosting works in compatibility chats and in the chat session of every new chat.
- 0.1 (2026-09-20): initial review draft.

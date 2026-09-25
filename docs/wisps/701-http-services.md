# WISP 701: HTTP Local Service Profile

| Field | Value |
|---|---|
| Candidate number | 701; editorial family allocation |
| Status | Draft |
| Revision | 0.2 |
| Updated | 2026-09-25 |
| Document kind | Profile |
| Dependencies | [700](700-local-services.md) |
| Implementation | Desktop/extension hosting in every chat: data-link frames in compatibility chats, the same frames inside `ph` frames in the chat session; web viewer where supported. |

> This Draft documents a bounded existing profile, not full contract conformance or an independent implementation certification.

## Wire and authorization mapping

`ghostly-http/1` resolves an advertised service ID to a locally configured loopback target. The remote peer chooses a validated relative path, never an arbitrary host/port. The host's service configuration and selected contact audience are authoritative; advertisements cannot add targets or grant access. Current browser-engine `sharedWith` checks govern per-contact service advertisements/access; historical all-contact behavior is not the current policy.

Control `req` frames carry request ID, service ID, method, path, sanitized headers and body presence. `res` carries status/headers/body presence; bounded binary chunks carry bodies and `rst` cancels/resets. Reject unknown/disabled/unauthorized service IDs, invalid methods/headers, target escape, excess body/concurrency and idle timeout. Do not inherit the host's cookies or local credentials.

## Runtime limits

Desktop uses native local fetch; extension can host permitted local services. An ordinary web tab does not gain arbitrary loopback access. In compatibility chats ([402](402-legacy-chat.md)) these frames ride the legacy data link; in the chat session of every new chat ([401](401-paired-chat.md)) the same frames travel inside `ph` application frames ([pairedHttp.ts](../../packages/core/src/pairedHttp.ts)), with no negotiated capability, so an older app drops them. Redirect containment differs across fetch implementations: browser follow-then-validate can observe a redirect only after it was followed. No WebSocket upgrade, SSE or end-to-end response-streaming support is implied by binary chunk framing.

## Evidence

[HTTP core](../../packages/core/src/http.ts), [service authorization](../../packages/browser/src/engine/node.ts), [native fetch](../../src-tauri/src/local_fetch.rs), [browser boundaries](../BROWSER.md). Check traversal, header/URL injection, wrong audience, disabled sharing, redirect escape and resource cleanup; document platform differences.

## Revision log

- 0.2 (2026-09-25): hosting in the chat session (`ph` frames) recorded; the earlier "not paired hosted HTTP" was wrong.
- 0.1 (2026-09-22): HTTP local service profile.

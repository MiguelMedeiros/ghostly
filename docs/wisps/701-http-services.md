# WISP 701: HTTP Local Service Profile

| Field | Value |
|---|---|
| Candidate number | 701; editorial family allocation |
| Status | Draft |
| Revision | 0.1 |
| Updated | 2026-09-22 |
| Document kind | Profile |
| Dependencies | [700](700-local-services.md) |
| Implementation | Legacy desktop/extension hosting; web viewer where supported; not paired hosted HTTP. |

> This Draft documents a bounded existing profile, not full contract conformance or an independent implementation certification.

## Wire and authorization mapping

`ghostly-http/1` resolves an advertised service ID to a locally configured loopback target. The remote peer chooses a validated relative path, never an arbitrary host/port. The host's service configuration and selected contact audience are authoritative; advertisements cannot add targets or grant access. Current browser-engine `sharedWith` checks govern per-contact service advertisements/access; historical all-contact behavior is not the current policy.

Control `req` frames carry request ID, service ID, method, path, sanitized headers and body presence. `res` carries status/headers/body presence; bounded binary chunks carry bodies and `rst` cancels/resets. Reject unknown/disabled/unauthorized service IDs, invalid methods/headers, target escape, excess body/concurrency and idle timeout. Do not inherit the host's cookies or local credentials.

## Runtime limits

Desktop uses native local fetch; extension can host permitted local services. An ordinary web tab does not gain arbitrary loopback access. The implemented legacy profile is distinct from paired sessions. Redirect containment differs across fetch implementations: browser follow-then-validate can observe a redirect only after it was followed. No WebSocket upgrade, SSE or end-to-end response-streaming support is implied by binary chunk framing.

## Evidence

[HTTP core](../../packages/core/src/http.ts), [service authorization](../../packages/browser/src/engine/node.ts), [native fetch](../../src-tauri/src/local_fetch.rs), [browser boundaries](../BROWSER.md). Check traversal, header/URL injection, wrong audience, disabled sharing, redirect escape and resource cleanup; document platform differences.

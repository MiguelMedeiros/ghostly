# WISP 701: HTTP Local Service Profile

| Field | Value |
|---|---|
| Candidate number | 701; editorial family allocation |
| Status | Draft |
| Revision | 0.3 |
| Updated | 2026-09-25 |
| Document kind | Profile |
| Dependencies | [700](700-local-services.md) |
| Implementation | Desktop/extension hosting in every chat: data-link frames in compatibility chats, the same frames inside `ph` frames in the chat session (`services/1`); web viewer where supported. |

> This Draft documents a bounded existing profile, not full contract conformance or an independent implementation certification.

## Wire and authorization mapping

`ghostly-http/1` resolves an advertised service ID to a locally configured loopback target. The remote peer chooses a validated relative path, never an arbitrary host/port. The host's service configuration and selected contact audience are authoritative; advertisements cannot add targets or grant access. Current browser-engine `sharedWith` checks govern per-contact service advertisements/access; historical all-contact behavior is not the current policy.

Control `req` frames carry request ID, service ID, method, path, sanitized headers and body presence. `res` carries status/headers/body presence; bounded binary chunks carry bodies and `rst` cancels/resets. Reject unknown/disabled/unauthorized service IDs, invalid methods/headers, target escape, excess body/concurrency and idle timeout. Do not inherit the host's cookies or local credentials.

## Runtime limits

Desktop uses native local fetch; extension can host permitted local services. An ordinary web tab does not gain arbitrary loopback access. In compatibility chats ([402](402-legacy-chat.md)) these frames ride the legacy data link; in the chat session of every new chat ([401](401-paired-chat.md)) the same frames travel inside `ph` application frames ([pairedHttp.ts](../../packages/core/src/pairedHttp.ts)), under `services/1` ([below](#paired-profile)). Redirect containment differs across fetch implementations: browser follow-then-validate can observe a redirect only after it was followed. No WebSocket upgrade, SSE or end-to-end response-streaming support is implied by binary chunk framing.

## Paired profile

In the chat session ([401](401-paired-chat.md#calls-and-shared-apps)) shared apps are on while both sides offer `services/1` on the live session. The host tells the contact which apps it granted that contact with `{"t":"paired-services","s":<list>}`, the same list as `hello.svc`, once the contact said `services/1` and again whenever a grant changes; the list is never published. HTTP travels as `{"t":"ph","c":"<control frame>"}` (the `req`, `res` and `rst` frames above) and `{"t":"ph","b":"<chunk>"}` (a body chunk, base64url), since application data on this session is text on every transport. Both sides MUST drop `paired-services` and `ph` frames unless both offer `services/1` on this session, and a request made without a live session fails without reaching the host. The host checks the grant on every request, not only when listing: an app the contact was not granted answers 404 whatever it asks.

The web app offers nothing here: a tab can neither reach a local address nor open a contact's app. A contact's app then says so in the chat's Services dialog, as it does on the DHT ("Shared apps open while you are connected live").

## Evidence

[HTTP core](../../packages/core/src/http.ts), [paired HTTP](../../packages/core/src/pairedHttp.ts), [session capabilities](../../packages/core/src/pairedCapabilities.ts), [service authorization](../../packages/browser/src/engine/node.ts), [native fetch](../../src-tauri/src/local_fetch.rs), [browser boundaries](../BROWSER.md). Check traversal, header/URL injection, wrong audience, disabled sharing, redirect escape and resource cleanup; document platform differences.

## Revision log

- 0.3 (2026-09-25): paired profile: `paired-services` and `ph` need `services/1` on both sides and a live session.
- 0.2 (2026-09-25): hosting in the chat session (`ph` frames) recorded; the earlier "not paired hosted HTTP" was wrong.
- 0.1 (2026-09-22): HTTP local service profile.

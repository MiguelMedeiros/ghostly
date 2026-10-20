# WISP 701: HTTP Local Service Profile

| Field | Value |
|---|---|
| Candidate number | 701; editorial family allocation |
| Status | Draft |
| Document kind | Profile |
| Dependencies | [700](700-local-services.md) |
| Implementation | Desktop/extension hosting in every chat: data-link frames in compatibility chats, the same frames inside `ph` frames in the chat session (`services/1`); web viewer where supported. |
| Summary | HTTP requests and responses carried over the chat's data link. |
| Availability | Available |
| Notes | Plain request/response. No WebSockets or streaming. |

> This Draft documents a bounded existing profile, not full contract conformance or an independent implementation certification.

## Wire and authorization mapping

`ghostly-http/1` resolves an advertised service ID to a locally configured loopback target. The remote peer chooses a validated relative path, never an arbitrary host/port. The host's service configuration and selected contact audience are authoritative; advertisements cannot add targets or grant access. Current browser-engine `sharedWith` checks govern per-contact service advertisements/access; historical all-contact behavior is not the current policy.

Control `req` frames carry request ID, service ID, method, path, sanitized headers and body presence. `res` carries status/headers/body presence; bounded binary chunks carry bodies and `rst` cancels/resets. Reject unknown/disabled/unauthorized service IDs, invalid methods/headers, target escape, excess body/concurrency and idle timeout. Do not inherit the host's cookies or local credentials.

## Runtime limits

Desktop uses native local fetch, which reaches only the loopback addresses (scheme, host and port) the person allowed for that profile in a native dialog the app shows when an app is shared, or once on first use for an app shared before that list existed; the page can remove an address, never add one. Extension can host permitted local services. An ordinary web tab does not gain arbitrary loopback access. In compatibility chats ([402](402-legacy-chat.md)) these frames ride the legacy data link; in the chat session of every new chat ([401](401-paired-chat.md)) the same frames travel inside `ph` application frames ([pairedHttp.ts](../../packages/core/src/pairedHttp.ts)), under `services/1` ([below](#paired-profile)). Redirect containment differs across fetch implementations: browser follow-then-validate can observe a redirect only after it was followed. No WebSocket upgrade, SSE or end-to-end response-streaming support is implied by binary chunk framing.

## Paired profile

In the chat session ([401](401-paired-chat.md#calls-and-shared-services)) shared services are on while both sides offer `services/1` on the live session. The host tells the contact which apps it granted that contact with `{"t":"paired-services","s":<list>}`, the same list as `hello.svc`, once the contact said `services/1` and again whenever a grant changes; the list is never published. HTTP travels as `{"t":"ph","c":"<control frame>"}` (the `req`, `res` and `rst` frames above) and `{"t":"ph","b":"<chunk>"}` (a body chunk, base64url), since application data on this session is text on every transport. Both sides MUST drop `paired-services` and `ph` frames unless both offer `services/1` on this session, and a request made without a live session fails without reaching the host. The host checks the grant on every request, not only when listing: an app the contact was not granted answers 404 whatever it asks.

The web app shares nothing: a tab cannot reach a local address. It offers `services/1` only when it can open a contact's app ([On the web](#on-the-web)); a host then lists it what it granted, and any request the contact makes of it answers 404, since it grants nothing. Without that, a contact's app says so in the chat's Shared services dialog (composer +): "<contact>'s app cannot open or share apps". On the DHT the same dialog says "Shared services open while you are connected live".

## On the web

A contact's app is the contact's code: run on the web app's origin it could read the profile's keys and wallets. A web app built with a services host (`VITE_SERVICES_HOST`, `https://*.<domain>`, a wildcard name served by the same server) opens each one on an origin of its own, `https://<label>.<domain>`, where `<label>` is 32 z-base-32 characters of SHA-256 over `ghostly-web-service/1`, the `viewerTag` of this side's chat key ([04](04-profiles.md)), the contact's key and the service ID: another profile, or the same one made again, gets another origin and none of what the app stored. On those names the server serves only a bridge page and a service worker (`/_ghostly-svc/bridge.html`, `/ghostly-services-sw.js`), with `frame-ancestors` naming only the web app's own origin (`VITE_SERVICES_APP_ORIGIN`). The web app frames the bridge full screen, in a sandbox without `allow-top-navigation`, and hands it a `MessagePort`; the bridge registers the worker and frames the app under it. Every request the app makes reaches the worker, which passes it over the bridge to the web app's page, which sends it on the chat's live session like any viewer and streams the answer back. The worker drops the app's `X-Frame-Options` and `frame-ancestors` and sets its own; the page keeps the app's cookies for as long as it is open (a worker sees none), sends them back by name, and the app's script cannot read them. Closing it, a reload and the profile locking end it with its requests and cookies. The services host SHOULD be a registrable domain of its own, not one the web app's origin is under: the apps' names are same-site with each other, so a script of one app may still set a cookie for the services domain that another app's script reads (no request carries it: the worker sees no cookie, and the page sends only the jar's). A build without a services host, or a browser without service workers, offers no `services/1` and says opening needs the extension or the desktop app.

## Evidence

[HTTP core](../../packages/core/src/http.ts), [paired HTTP](../../packages/core/src/pairedHttp.ts), [session capabilities](../../packages/core/src/pairedCapabilities.ts), [service authorization](../../packages/browser/src/engine/node.ts), [native fetch](../../apps/desktop/src/local_fetch.rs), [browser boundaries](../BROWSER.md). Check traversal, header/URL injection, wrong audience, disabled sharing, redirect escape and resource cleanup; document platform differences.

## Revision log

One file per change in [changes/701-http-services/](changes/701-http-services/) ([how](00-process.md#revisions)). The site lists them here, newest first, and derives the Revision and Updated rows from them.

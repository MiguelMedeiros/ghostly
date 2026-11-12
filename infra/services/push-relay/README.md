# Push relay (optional)

Ghostly wakes a contact's closed web app with a push the sender's own app posts to the contact's push
service (WISP 401 § Wake-up push). Desktop and the CLI post it themselves. A browser page usually cannot:
push services answer without CORS. For those senders, a person may set a relay in **Settings → Network →
Push relay**; the app then hands it the finished request, already encrypted and signed.

This is that relay: one Node file, no dependencies, nothing stored. It only posts to the big push
services (Google, Apple, Mozilla, Microsoft) on their default port, only forwards a request signed for Web Push
(a VAPID `Authorization`) with the Web Push headers, and limits each address (an IPv6 one by its /64) to 30
requests a minute, and each subscription (an endpoint with its VAPID key) to 30 forwards a minute from all
addresses together; a forward the push service refuses (a 4xx other than 429) counts against the sender's address only. When its table of addresses, or of subscriptions, is full it forgets the one seen longest ago. A client has 15 seconds
to send its whole request; a request is weighed in bytes and one too large is refused before it is read, and so is
a header named twice, or a Web Push header whose value `fetch` would not send (a NUL, a line break, another control
character, a character above U+00FF), with a 400 that names the header (`{"error":"Bad TTL value"}`). It learns
that a push to an endpoint happened, when, and the sender's address; it never sees what the push says
(only "wake up"), since that is encrypted to the contact's browser.

It needs Node 18 or later (22 is what the HyperDHT relay's image runs): it posts with Node's own `fetch`, and on an
older Node it would start and then fail every push.

```bash
node server.mjs                                   # port 49480
PORT=8443 GHOSTLY_RELAY_ORIGINS=https://app.ghostly.tools node server.mjs
curl -s http://127.0.0.1:49480/healthz           # {"ok":true}
```

`GET /healthz` answers 200 `{"ok":true}` while the relay runs. Point a monitor at it: `HEAD` and a query string
(`/healthz?x=1`) answer the same, and are not logged as refusals; any other `GET` is refused (405, `Allow: POST, OPTIONS`) with what the relay is (`{"error":"Ghostly push relay: POST a push to it"}`), so its address opened in a browser says it runs. Anyone who reaches the relay may read it, so it carries no count: pushes forwarded, failed and refused are in
the log (below).

A port another program holds or one below 1024 this user may not take (`PORT`), and a `HOST` that is no address of
this machine or no name at all, stop the start with one line that names the setting instead of a stack trace.

Put it behind HTTPS (a tunnel or a reverse proxy) and enter its address in Settings. Behind a proxy, set
`GHOSTLY_RELAY_PROXIES` to the number of proxies in front of it (`1` for one tunnel), so the limit counts each
client's address from `X-Forwarded-For` rather than the proxy's; without it the header is ignored, and the first request
that carries one logs `requests carry X-Forwarded-For but GHOSTLY_RELAY_PROXIES is not set`. With proxies set,
the relay listens on 127.0.0.1 unless `HOST` says otherwise: only the proxy should reach it, since anyone else could
write that header. Ghostly runs none for you: no relay is set by default.

`GHOSTLY_RELAY_ORIGINS` lists the pages allowed to use it, comma-separated, each an origin as a browser sends it:
scheme, host and a port only (`https://app.ghostly.tools`, `http://localhost:5173`). Case, a default port (`:443`)
and a trailing `/` do not matter; an entry with a path, a query or no scheme (`https://app.ghostly.tools/chat`,
`app.ghostly.tools`) stops the start. Left out, any page may use it. A page it refuses gets a 403 it can read
(`{"error":"Origin not allowed"}`), and the log names the origin on the refusal's first line (`refused origin
"<origin>"`, below). It keeps other websites from using the relay; it is no defence against other programs.

A forward the push service did not answer is logged as `failed` with its cause, never the endpoint: `timeout` (10
seconds), `ENOTFOUND` (no DNS), `ECONNREFUSED` or `ETIMEDOUT` (no way out to port 443), a TLS code such as
`CERT_HAS_EXPIRED`, or `redirect`.

A setting that is there but empty or not of its kind (`PORT=`, `GHOSTLY_RELAY_PROXIES=one`) stops the start with one
line that names it; leave a setting out for its default. The start line says how many proxies it counts, where it
listens and which origins it serves (`any origin` when none is set). Before it, a line names each `GHOSTLY_RELAY_*` or
`GHOSTLY_HYPERDHT_*` variable the push relay does not read, with the closest name it does
(`GHOSTLY_RELAY_ORIGIN (GHOSTLY_RELAY_ORIGINS?) is not a setting of this relay; ignored`). It has no Cloudflare mode
and no limit variables, so the HyperDHT relay's `GHOSTLY_RELAY_CLOUDFLARE` and `GHOSTLY_RELAY_<LIMIT>` show there too.

The log holds counts and reasons only, never an endpoint or an address: `forwarded <status>`, `failed <cause>`, and
each refusal by kind (`refused origin`, `refused method`, `refused rate`, `refused size`, or what was wrong with the
request, such as `refused Not a push service` or `refused Bad TTL value`). The first of each (a status, a cause, a
kind of refusal) is logged at once and the rest as one count a minute (`forwarded 201 4120 more`, `refused rate 41
more`), so busy traffic or a flood stays a line a minute each. A refused origin's first line names it, quoted
(`refused origin "https://app.ghostly.tools.example"`, `refused origin (none)` without one), so a misspelt
`GHOSTLY_RELAY_ORIGINS` shows; the count after it covers every origin refused that minute. On a stop, the relay
waits up to 3 seconds for the requests still open, then writes the counts, so a push that went out while it stopped is
in the log; forwards still waiting on the push service when it cuts them are one line (`cut 2 forwards in flight`).

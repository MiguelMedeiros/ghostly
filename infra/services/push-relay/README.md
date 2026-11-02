# Push relay (optional)

Ghostly wakes a contact's closed web app with a push the sender's own app posts to the contact's push
service (WISP 401 § Wake-up push). Desktop and the CLI post it themselves. A browser page usually cannot:
push services answer without CORS. For those senders, a person may set a relay in **Settings → Network →
Push relay**; the app then hands it the finished request, already encrypted and signed.

This is that relay: one Node file, no dependencies, nothing stored. It only posts to the big push
services (Google, Apple, Mozilla, Microsoft) on their default port, only forwards a request signed for Web Push
(a VAPID `Authorization`) with the Web Push headers, and limits each address (an IPv6 one by its /64) to 30
requests a minute. When its table of addresses is full it forgets the one seen longest ago. A client has 15 seconds
to send its whole request; a request is weighed in bytes and one too large is refused before it is read, and so is
a header named twice. It learns that a push to an endpoint happened, when, and the sender's address; it never
sees what the push says (only "wake up"), since that is encrypted to the contact's browser.

```bash
node server.mjs                                   # port 49480
PORT=8443 GHOSTLY_RELAY_ORIGINS=https://app.ghostly.tools node server.mjs
```

Put it behind HTTPS (a tunnel or a reverse proxy) and enter its address in Settings. Behind a proxy, set
`GHOSTLY_RELAY_PROXIES` to the number of proxies in front of it (`1` for one tunnel), so the limit counts each
client's address from `X-Forwarded-For` rather than the proxy's; without it the header is ignored. With proxies set,
the relay listens on 127.0.0.1 unless `HOST` says otherwise: only the proxy should reach it, since anyone else could
write that header. Ghostly runs none for you: no relay is set by default.

`GHOSTLY_RELAY_ORIGINS` lists the pages allowed to use it, comma-separated, each an origin as a browser sends it:
scheme, host and a port only (`https://app.ghostly.tools`, `http://localhost:5173`). Case, a default port (`:443`)
and a trailing `/` do not matter; an entry with a path, a query or no scheme (`https://app.ghostly.tools/chat`,
`app.ghostly.tools`) stops the start. Left out, any page may use it. A page it refuses gets a 403 it can read
(`{"error":"Origin not allowed"}`), and the log says `refused origin "<origin>"` once an hour per origin, for at most
16 origins an hour. It keeps other websites from using the relay; it is no defence against other programs.

A setting that is there but empty or not of its kind (`PORT=`, `GHOSTLY_RELAY_PROXIES=one`) stops the start with one
line that names it; leave a setting out for its default. The start line says how many proxies it counts, where it
listens and which origins it serves (`any origin` when none is set).

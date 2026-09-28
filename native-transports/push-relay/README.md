# Push relay (optional)

Ghostly wakes a contact's closed web app with a push the sender's own app posts to the contact's push
service (WISP 401 § Wake-up push). Desktop and the CLI post it themselves. A browser page usually cannot:
push services answer without CORS. For those senders, a person may set a relay in **Settings → Network →
Push relay**; the app then hands it the finished request, already encrypted and signed.

This is that relay: one Node file, no dependencies, nothing stored. It only posts to the big push
services (Google, Apple, Mozilla, Microsoft) on their default port, only forwards a request signed for Web Push
(a VAPID `Authorization`) with the Web Push headers, and limits each address to 30 requests a minute. It learns that a push to an endpoint happened, when, and the sender's address; it never
sees what the push says (only "wake up"), since that is encrypted to the contact's browser.

```bash
node server.mjs                                   # port 49480
PORT=8443 GHOSTLY_RELAY_ORIGINS=https://app.ghostly.tools node server.mjs
```

Put it behind HTTPS (a tunnel or a reverse proxy) and enter its address in Settings. Behind a proxy, set
`GHOSTLY_RELAY_PROXIES` to the number of proxies in front of it (`1` for one tunnel), so the limit counts each
client's address from `X-Forwarded-For` rather than the proxy's; without it the header is ignored. Ghostly runs none for
you: no relay is set by default.

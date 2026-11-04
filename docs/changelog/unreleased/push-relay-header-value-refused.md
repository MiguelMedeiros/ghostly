---
section: Fixed
---
- Push relay (self-hosted): a request with a Web Push header value Node's `fetch` cannot send (a NUL, a line break, another control character, a character above U+00FF) is refused with a 400 that names the header (`Bad TTL value`) and logged as a refusal (`refused Bad TTL value`). Before, it was answered with a 502 "The push service did not answer" and counted and logged as `failed error`, though no push service was contacted.

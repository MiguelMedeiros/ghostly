---
section: Fixed
---
- Push relay (self-hosted): a push it could not hand to the push service is logged with the cause (`failed timeout`, `failed ENOTFOUND`, `failed ECONNREFUSED`, a TLS code such as `failed CERT_HAS_EXPIRED`), never the endpoint. Before, it logged only `failed`, so no DNS, a firewall without outgoing 443, a TLS error and the 10-second timeout looked the same.

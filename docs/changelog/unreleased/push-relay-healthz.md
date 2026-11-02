---
section: Fixed
---
- Push relay (self-hosted): `GET /healthz` answers 200 with its counts since the start (pushes forwarded, forwards that failed, requests refused, addresses tracked), so an operator or a monitor can check it is up. Before, every `GET` was refused with 405 and the README named no check.

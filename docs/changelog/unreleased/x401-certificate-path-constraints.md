---
section: For developers / CLI
release: 1.4
---
- The certificate check of a signed x401 request now honours what a certificate says about its own use: a CA's path length and DNS name constraints (the root's too), the leaf's key usage, an extended key usage that leaves servers out, and critical extensions it does not know. A CA constrained to other names, or one with no room left for another CA below it, can no longer stand behind a request for any host.

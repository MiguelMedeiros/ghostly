---
section: For developers
---
- The dependency scan (`tools/scripts/security-scan.mjs`, the Security workflow) reads every lockfile that ships. It read the root's two and the site's, and skipped the Desktop's HyperDHT sidecar (56 packages), the HyperDHT relay for browsers (74) and Iroh for browsers (361 crates), which each have a lockfile of their own: a known advisory in one of them left Security green. All three are clean today. A test holds the scan's list to the repository, so a new lockfile is scanned or named as test-only with the reason.

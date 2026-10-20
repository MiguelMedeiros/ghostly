---
section: For developers
---
- Dependencies: `follow-redirects` (a dev dependency, pulled in by `solc` for the contract tests) moves from 1.16.0 to 1.16.1, which fixes GHSA-8r9p-f939-6h3c (credential headers could survive a cross-host redirect). The dependency scan is green again on every pull request.

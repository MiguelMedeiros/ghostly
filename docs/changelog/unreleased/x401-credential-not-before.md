---
section: For developers / CLI
release: 1.4
---
- An x401 credential that is not valid yet (its `nbf` is in the future) is no longer offered to a verifier, who would refuse it; `x401 credential list` shows from when it is valid (`notBefore`).

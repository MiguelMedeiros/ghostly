---
section: Fixed / CLI
---
- `payment list` no longer calls a request that can be paid in ecash or over Lightning `lightning`: its `method` is `cashu`, the way `chat pay-request` pays it, and a request's new `methods` lists every way it can be paid.

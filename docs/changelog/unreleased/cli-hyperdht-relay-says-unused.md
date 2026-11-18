---
section: Fixed / CLI
---
- `settings set hyperdhtRelay <address>` now says on stderr that the CLI runs HyperDHT itself and does not dial through that relay (it uses it only with Hide my IP from contacts, not settable yet), so the value is kept for the apps the profile moves to. Before, it answered with the relay as if in effect and nothing said otherwise. `ghostly help settings set`, the README and docs/CLI.md say so too.

---
section: Fixed / CLI
---
- `group edit` now answers `sent: false` while no member's edge took the edit, as `group send` does (without a daemon, or with every member away). Before, it answered `sent: true` with `edges: 0` though nobody had the edit yet.

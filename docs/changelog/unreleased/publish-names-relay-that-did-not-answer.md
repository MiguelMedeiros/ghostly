---
section: Fixed / CLI
---
- A publish that no relay answered names each relay that did not answer (`Publish failed on every relay: Error: http://127.0.0.1:1 did not answer`), in `invite create`'s `reason`. Before, it read Node's "TypeError: fetch failed", with no relay named.

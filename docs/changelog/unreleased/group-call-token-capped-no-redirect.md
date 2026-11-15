---
section: For developers / Calls
---
- A group call's pass request reads the node's reply only up to 64 KiB and stops there, instead of reading all of it first, and follows no redirect: a node's endless or packed reply no longer fills the engine's memory, and a redirect no longer sends the member's key and name to a host the group never named.

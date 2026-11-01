---
section: Fixed / CLI
---
- A `ghostly` command that only reads the profile (`chat list`, `settings get`, `status`) and a profile set offline with `settings set online false` no longer contact the Mainline DHT. Before, every command joined the DHT through its public routers as it started, sending them this machine's address, even when the profile was set offline.

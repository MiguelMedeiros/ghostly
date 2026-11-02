---
section: Fixed / Self-hosting
---
- The self-hosted push relay and HyperDHT relay now stop with one line naming the setting to change when their port is
  already in use or needs root (`PORT`), or when `HOST` is no address of the machine, instead of a Node stack trace. The
  HyperDHT relay also checks `GHOSTLY_HYPERDHT_BOOTSTRAP` at start: each node must be `host:port`.

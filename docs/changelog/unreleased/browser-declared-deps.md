---
section: For developers / Dependencies
---
- packages/browser declares the packages its code imports (@noble/ciphers, @noble/curves, @noble/hashes, @scure/base, keet-identity-key and @ghostly/iroh-web) at the versions core pins, instead of getting them through core's hoisting. A test holds every workspace's `src` imports to its own package.json.

---
section: For developers / Dependencies
---
- HyperDHT moves from 6.34.0 to 6.34.1 in every copy at once: the packages, the Desktop's sidecar and the relay for browsers, with `tools/patches/hyperdht+6.34.1.patch` renamed to match. 6.34.1 is one fix: a server clears a relayed handshake when its relay aborts. A test now holds the four copies, their lockfiles and the patch's name to one version.

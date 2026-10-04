---
section: For developers
---
- Third part of "one profile on several devices, one active at a time" (WISP 06): device signing keys and the links
  between a person's devices. Each device makes its own Ed25519 signing key, non-extractable through WebCrypto where
  the engine keeps such a key (measured in Chromium, WebKit and the Desktop's WKWebView on a Mac) and a stored seed
  elsewhere, kept apart from the device record and in no backup. A paired session can sign through that key instead of
  a raw seed; chats sign exactly as before. The link between two devices is derived from the device-set secret and the
  two signing keys (test vectors included), pinned to the other device's key with trust on first use off, and run by
  device-link-only mode without opening the profile's database. It carries a ping and its echo for now. The turn
  keeper signs with the device's key. A profile on one device makes no key and starts no link.

---
section: For developers
---
- The read lane through which a contact's mini-app reads a file this side's app serves (`app-ranges/1` in WISP 1200) now has its frames and its binary chunk (kind `0x05`) read and written in `@ghostly/core`, with vectors. Nothing offers it yet: a later change carries it on the session.

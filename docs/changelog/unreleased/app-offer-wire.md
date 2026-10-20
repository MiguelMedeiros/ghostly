---
section: For developers
---
- A file a mini-app sends ahead to the contact (WISP 1200 § Sending a film ahead) now carries the app's chat app id as `app` on its `files/3` offer, read and written in `@ghostly/core` and kept with the received file. Nothing sends one yet: a later change gives apps `ghostly.files.offer`.

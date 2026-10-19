---
section: For developers
---
- A mini-app granted `files` and `chat` can let the same app on the contact's side read one of the files the person picked, in a chat open on both sides: `ghostly.files.serve(id)` gives a serve id to pass along, `files.unserve` ends it, and the contact's app reads it with `ghostly.remote.read(serveId, {offset, length})` (up to 1 MiB a call) and `remote.stat`. The bytes travel on the chat's own connection beside files, not through `chat.send`'s 32 KiB frames.

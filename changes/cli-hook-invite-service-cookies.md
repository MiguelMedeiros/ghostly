---
section: Security / Everywhere
---
- CLI: a `chat.created` event no longer carries the new chat's invite code, so a hook or bridge on `ghostly listen` never sees it (`invite create` and `chat show` still give it to you).
- CLI: a contact's app opened with `service open` gets only the cookies it set itself; cookies other apps on this machine keep for 127.0.0.1 or localhost stay here.

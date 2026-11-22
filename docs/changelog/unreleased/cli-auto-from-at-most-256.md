---
section: Fixed / CLI
release: 1.14
---
- `call auto on --from` and `group auto on --from` (and `call.auto`, `group.auto` on the socket) take at most 256 distinct chats: more is refused (`bad_request`, "At most 256 chats in --from; got 300.") before any is looked up, and the setting stays as it was. Each one was looked up over every chat, however many a script gave. The same ref given again still counts once.

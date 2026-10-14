---
section: Fixed / CLI
---
- `settings set iceServers` takes a server as WebRTC writes it, with `urls` a list (`[{"urls":["stun:…"]}]`), and a server without `urls` is refused with what to write (`bad_request`). Before, both failed with a JavaScript TypeError as the message.

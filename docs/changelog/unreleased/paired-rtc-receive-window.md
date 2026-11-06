---
section: Fixed / Transports
---
- A contact's app that sends WebRTC signal after signal while a chat moves to WebRTC no longer makes Ghostly start a new connection for each one: it reads at most 60 such signals a minute from a contact, far more than a move needs.

---
section: Fixed / CLI
---
- A one-shot command that changes a long chat (`ghostly send`, `edit`, `react` and the like, with no daemon running) no longer reads the chat's whole history a second time just to report its own message as an event. In a chat of 100,000 messages, `ghostly send` took 2.3 s and 365 MB, and now takes 1.5 s and 315 MB. The events it reports are unchanged.

---
section: Fixed / Chat
---
- Editing a message, while the chat is on the DHT, into a text too long for its packet once it carries the edit (about 215 bytes and up) no longer leaves the edit waiting for good with no reason while your contact keeps the old text. In a DHT-only chat it is refused at once with "Too long for the DHT" in the app's language; otherwise it goes once you are live, and the CLI's `edit` says so.

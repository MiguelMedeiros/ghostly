---
section: Fixed / CLI
---
- `chat connect` and `chat pay` on a chat whose invite someone else used first now refuse at once with the sentence `send` gives ("Someone else joined with this invite first. Ask your contact for a new one.", code `refused`, exit 1). Before, `chat connect` dialed for 120 s and answered `timeout`, a code a bot retries.

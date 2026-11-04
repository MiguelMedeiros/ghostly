---
section: Fixed / CLI
---
- A contact's message that reads like a joined line, such as "👋 I just joined", reaches `events` and `listen` as `message.received`. Only the line the chat shows as the contact's joined line is `chat.joined`. Before, every such message was `chat.joined`, which a bot does not answer, so the message never reached it.

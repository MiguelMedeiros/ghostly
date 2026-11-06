---
section: Fixed / CLI
---
- `ghostly file send` to a chat whose wait runs out (the contact away, or a big file still on its way) now says the file is kept and goes on, and answers its `chat`, `messageId` and file id in `details`, as `send` does. Before, it said only "Timed out … waiting for file … to arrive", with no `details` at all while the contact was away, so a bot could not delete, pin or react to the file, and a person sent it again.

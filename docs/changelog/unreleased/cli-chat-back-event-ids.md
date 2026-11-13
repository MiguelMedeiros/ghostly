---
section: Fixed / CLI
---
- A chat joined again from the same invite, or a group joined again, and its removal again, now come on `listen` with event ids of their own. They had the ids of the first time, so a bot that drops events it has seen (by `id`, as the CLI's docs say) never heard the chat or group came back, or went again.

---
section: Fixed / Chat
---
- At start the Tasks board reads its card index once, not once for each batch of chats and groups the app loads (three reads at once with a large profile, two of them thrown away). A chat or group that comes later still reads it again, once however many come while that read is on its way.

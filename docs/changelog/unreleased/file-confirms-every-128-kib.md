---
section: Fixed / Chat
---
- Receiving a large file in a chat, the app and the CLI confirm it to the sender every 128 KiB, not after almost every
  16 KiB piece: 800 confirms for 100 MiB instead of up to 6,400, each a call into the Desktop app's native side.

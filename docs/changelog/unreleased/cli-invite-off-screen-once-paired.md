---
section: Fixed / CLI
---
- A daemon reads a contact that is away at the same slow pace as its other chats. The chat of its last `invite create` or `invite join` stayed the chat "on screen" for good, so while that contact was away the daemon read it 2.5 to 3 times as often, about 18 of a Pkarr relay's 30 requests a minute. It now stops once the chat is paired.

---
section: Fixed / Everywhere
---
- On the active device of a profile on several devices, Ghostly checks which device is active once when the app starts, not twice. The second check, made a moment after the first one, asked the DHT and every relay again for a record this device had just written, and took a share of the relay requests the chats need at start.

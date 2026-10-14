---
section: Fixed / Everywhere
---
- With no network, the app no longer redraws the chat list every second or two for chats that never synced. Each failed look for such a chat made the page read every stored chat again: about 540 reads a second with 50 chats. Now a chat shows its first sync under way during its first look only, and a failed look changes nothing on screen.

---
section: Fixed / CLI
---
- A CLI daemon with many chats places, rings and answers a call without reading the list of all its chats five or six times on the way: about 0.2 s of its thread per call at 2,000 chats, and about a second at 10,000. A call that names its chat by id (as events and auto-answer do) reads that chat alone; one named by a label reads the list once.

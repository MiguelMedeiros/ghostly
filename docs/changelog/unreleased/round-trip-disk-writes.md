---
section: Fixed / Chat
---
- A live chat no longer writes its connection history to disk every time its round trip moves by 10 ms. The round trip still shows at once; on disk it is kept at most every 5 minutes, with no disk sync of its own, so an idle chat on an internet connection makes about 11 writes an hour where it made about 95 to 150. A power cut loses at most the last 5 minutes of round-trip changes, never a line of the history.

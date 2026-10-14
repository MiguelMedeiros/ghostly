---
section: Fixed / CLI
---
- A daemon no longer checks the signature of a discovery packet it has just signed, twice per packet: about 0.5 s of CPU a minute for a daemon with many chats at its relay budget, 70% of what it spent idle.

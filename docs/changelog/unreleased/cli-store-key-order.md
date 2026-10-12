---
section: For developers / CLI
---
- A profile's store comes back from disk faster at each start of a daemon or of a command run without one: its keys are put in order directly, where each comparison went through a check and a copy of both keys. With 100,000 stored messages that is 0.85 s instead of 1.4 s.

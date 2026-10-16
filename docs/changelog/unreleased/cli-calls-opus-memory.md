---
section: Fixed / CLI
---
- A CLI daemon in three or more calls at once keeps every call's audio intact. Before, as calls ended and others started, one call's audio could be written over another's codec: that call turned to noise, answers and hang-ups failed with "memory access out of bounds", and after a few rounds no call worked until the daemon restarted.

---
section: For developers / CLI
---
- A daemon no longer waits for the disk each time it notes an event it reported. A text sent cost nine disk syncs, three of them for these notes, each holding every other chat, the socket API and `listen` for milliseconds; the notes now go to disk with the next write, or within a second. After a power cut, an event of the last second may be reported again.

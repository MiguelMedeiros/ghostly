---
section: Fixed / Calls
---
- A call on Ghostly Desktop for Linux uses less CPU. The page no longer keeps an empty audio output open for the whole call: it cost 4 to 6% of a core and an extra PipeWire stream, for a sound that only ever plays in the app's own call engine.

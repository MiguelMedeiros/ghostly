---
section: Fixed / Everywhere
---
- The CLI and Desktop-headless load a profile's saved store much faster at start. A profile with 70,000 messages took about 9 seconds to load before a daemon, or any command run without one, could begin. It now takes about 0.7 seconds. The store is also no longer rewritten at every start when nothing changed since it was saved.

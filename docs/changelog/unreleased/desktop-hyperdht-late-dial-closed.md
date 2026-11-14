---
section: Fixed
---
- Desktop: a HyperDHT connection that comes through only after the app stopped waiting for it (25 s, on a slow path) is closed at once. Before, it stayed open with nothing reading it, kept one of the chat's two HyperDHT places, and left the contact on a connection that never started a session.

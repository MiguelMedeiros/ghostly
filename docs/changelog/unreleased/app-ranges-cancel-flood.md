---
section: For developers
---
- On the read lane (`app-ranges/1`), a request the contact cancels keeps its place among the 4 per app until the read under it ends, so a contact that asks and cancels over and over gets `busy` instead of starting more file reads on the other device.

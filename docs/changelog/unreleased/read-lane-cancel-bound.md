---
section: For developers
---
- On the read lane (`app-ranges/1`), a request the contact cancels keeps its place among its app's 4 in flight until this side has stopped reading and sending it. A loop of `ar-get` and `ar-cancel` used to free each place at once and start a new read of up to 1 MiB every time; past 4 it is now answered `busy`.

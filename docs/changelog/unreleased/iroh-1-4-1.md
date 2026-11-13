---
section: For developers / Dependencies
---
- Iroh moves from 1.3.0 to 1.4.1 in the Desktop app, the CLI and the web app (its browser build rebuilt), with noq 1.4.0. noq 1.4.0 closes a whole connection once one of its streams holds about 2,048 packets not read yet, so the Desktop's Iroh now lets a contact send 2 MiB on the chat's stream before it is read, not 4 MiB: a reader that falls a whole window behind keeps its connection. Files over the Desktop's Iroh can be slower on fast, long paths (above about 100 Mbit/s at 150 ms) until a noq release merges those packets again.

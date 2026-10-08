---
section: Fixed / Everywhere
---
- Sending a file costs much less of the app's time: each piece of a file is turned into text before it goes out, and that step took about 45 ms per MiB (some 9 s of a 200 MiB file's sending). It now uses the browser's or Node's own encoder where there is one (about 0.3 ms per MiB) and a faster one elsewhere (about 3 ms per MiB, e.g. the CLI on Node 22 and 24). The same text goes over the wire, so nothing changes for the contact.

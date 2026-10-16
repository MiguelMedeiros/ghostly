---
section: Fixed / Everywhere
---
- Each message that arrives no longer rewrites a 29 KB list in the browser's storage. The app claimed every sound and notification by writing back the last 256 message ids each time: a busy group of 10,000 messages wrote about 290 million characters, and each write also reached every other open page. A claim is now a few dozen characters, kept for 10 seconds.

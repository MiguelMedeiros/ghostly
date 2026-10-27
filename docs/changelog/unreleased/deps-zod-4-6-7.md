---
section: Security / Everywhere
---
- The app and the CLI use zod 4.6.7: before 4.6.6, checking a very large list sent by someone else could use up the memory and stop the app (GHSA-mrhx-c7xc-m3w5).

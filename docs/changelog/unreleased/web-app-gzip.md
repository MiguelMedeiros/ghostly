---
section: Fixed / Web app
---
- app.ghostly.tools sends its scripts and styles compressed again: a first visit (the app and what it keeps for offline use) downloads about 3.5 MB instead of 10.6 MB, and each update downloads about a third of what it did. Since the site told Cloudflare to change nothing in its answers, Cloudflare stopped compressing them too, and the server now does it itself.

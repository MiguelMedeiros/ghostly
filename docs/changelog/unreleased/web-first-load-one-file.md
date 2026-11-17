---
section: Fixed / Web
---
- The web app downloads about 60 KB less (gzip) when it opens, and up to 125 KB less where the server sends brotli. What it runs on load was split into some 95 files, each compressed on its own and asked for one by one; it is now one file. Desktop, Android and the browser extension are unchanged.

---
section: For developers / Web
---
- CI now checks that every file the web app's service worker installs is in the build (`npm run check:web-precache`). The worker's list is read once Vite has written index.html, so it no longer names the entry chunk Vite folds into the page, which nginx answered with a 404 and which failed the worker's install.

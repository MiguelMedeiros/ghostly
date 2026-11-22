---
section: For developers / Web
---
- CI now checks that every file the web app's service worker installs is in the build (`npm run check:web-precache`). The worker's lists leave out the entry chunk Vite folds into the page, which nginx answered with a 404 and which failed the worker's install, while what that entry loads is still precached, so the installed app opens offline. The web build fails if the worker would not precache a script or stylesheet index.html loads.

---
section: Fixed / Everywhere
---
- The web app no longer downloads its own files twice. The first time it opens, the files the page has just loaded are kept for offline use from the browser's copy (56 files, about 1.3 MB over the network, were fetched a second time). After an update, only the files that changed are downloaded: an update that changed one file took 155 requests and about 4.5 MB before, and takes 9 requests and about 0.7 MB now.

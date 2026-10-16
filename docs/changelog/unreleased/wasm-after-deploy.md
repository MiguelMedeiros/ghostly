---
section: Fixed / Everywhere
---
- Web app: a wallet, or the Iroh connection, opened for the first time in a tab left open across an update could fail to load, because the server no longer had that build's file and Try again could not bring it back. The tab now learns of the new version the moment that happens and offers Reload, instead of at its next check hours later; a new build of the same version is offered too, named as one, where before only a newer version number was. The app's own files and the parts it loads as you go were already kept whole across an update; this covers the WebAssembly, which is fetched the first time it is needed.

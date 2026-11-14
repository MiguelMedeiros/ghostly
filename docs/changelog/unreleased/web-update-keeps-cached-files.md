---
section: Fixed / Web
---
- In the web app, getting a new version no longer downloads again the files it already holds once the browser has let go of its own copies (after "Clear cached images and files", or when they aged out): the update takes every unchanged file from the version before, so a version that changed 2 files downloads those 2 (2.6 MiB in a local build), not 203 (8.5 MiB), and a wallet's WebAssembly (up to 12 MiB) is not downloaded again at its next use.

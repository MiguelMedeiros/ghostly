---
section: For developers / CI
---
- A published release now sends its browser extension to the Chrome Web Store by itself: `chrome-web-store.yml` uploads the release's zip and submits it for review through the Chrome Web Store API, as a service account. It stays off until the `chrome-web-store` environment, which only main and release tags may use, has the store's credentials (docs/RELEASING.md, "Chrome Web Store"), skips drafts, pre-releases and versions the store already has, and never holds the release back.

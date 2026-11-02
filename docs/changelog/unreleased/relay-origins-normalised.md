---
section: Fixed / Self-hosting
---
- The push relay and the HyperDHT relay (`infra/services`) read `GHOSTLY_RELAY_ORIGINS` as a browser sends an origin: `https://app.ghostly.tools/`, `HTTPS://App.Ghostly.Tools` and `https://app.ghostly.tools:443` now let the web app in, where they turned every browser away with 403. An entry with a path or a query stops the start with one line naming it. Both start lines say which origins they serve (or `any origin`), both log a refused origin once an hour, and the push relay's refusal is now a 403 the page can read, not a CORS error.

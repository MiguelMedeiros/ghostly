---
section: Fixed / Everywhere
---
- A Pkarr relay that fails for a moment while the app starts is left alone for a minute, then asked again, instead of five minutes: the requests already sent to it when it failed no longer count as new failures.

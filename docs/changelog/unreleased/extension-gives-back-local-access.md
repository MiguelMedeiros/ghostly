---
section: Fixed / Extension
---
- The browser extension gives back its access to a local address (`http://127.0.0.1`, `localhost`, `[::1]`) once no
  profile shares an app there any more: when the last such app is removed, on Clear all data and when a profile is
  deleted. It kept that access for good before.

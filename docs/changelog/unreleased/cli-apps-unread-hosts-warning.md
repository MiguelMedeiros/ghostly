---
section: Fixed / CLI
---
- `store sign` now says which listings have no URL on raw.githubusercontent.com or cdn.jsdelivr.net, the only hosts clients read apps from: the store shows them and their Install fails. `app publish` says the same when none of the manifest's `sources` is on those hosts: clients would never find the app's updates or revocations. Both still sign; they said nothing before.

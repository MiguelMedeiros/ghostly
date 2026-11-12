---
section: Fixed / CLI
---
- The CLI from npm installs the exact dependency versions it was released and tested with. It now ships a lockfile (`npm-shrinkwrap.json`), so `npm install -g @ghostlytools/cli` no longer picks up whatever newer versions the dependency ranges allowed on the day of the install. Its HyperDHT also carries the fix the apps already have, for a first connection that could stay silent for about 13 seconds when the computer is reachable directly.

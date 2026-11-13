---
section: Fixed / CLI
---
- `ghostly app verify` and `ghostly app serve` of a URL give up on a URL after 60 seconds in all, its redirects included. A host that redirected just before each wait ran out could hold a read for up to six minutes.

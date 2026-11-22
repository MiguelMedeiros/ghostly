---
section: Fixed / Apps
---
- `ghostly app publish` and `ghostly store sign` no longer sign a link with a query or fragment into the bundle's `sources` or a listing's `urls`. A private repository's raw link carries its access token there, and a bundle and a store index are public. Both now refuse it (`private-link`), as `app serve --url` already did, and write nothing.

---
section: Fixed / Apps
---
- `ghostly app verify` and `ghostly app serve` of a link no longer repeat its query in an error: a private repository's raw link carries its access token there, and a bot's log kept it. The link is said up to its path, then `?…` (for example "https://raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp?… answered 404").

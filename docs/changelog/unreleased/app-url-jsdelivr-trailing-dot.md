---
section: Fixed / Apps
---
- `ghostly store sign`, `app verify` and `app serve` now refuse a jsDelivr branch URL written with a trailing dot in
  its host (`https://cdn.jsdelivr.net./gh/<owner>/<repo>@main/...`), as they already refuse it without the dot: only a
  pinned commit is taken.

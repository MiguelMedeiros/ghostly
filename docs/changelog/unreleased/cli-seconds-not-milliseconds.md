---
section: Fixed / CLI
---
- `routine send/update --next`, `usage send --resets` and `--also`, and `chat/group history --before/--after` refuse Unix seconds with the milliseconds they mean (exit 2). Before, seconds were taken as milliseconds: a card was dated January 1970 and a history page came back empty or whole. A history cursor of digits is now always a time, so `--after 0` reads from the start instead of answering "No message 0".

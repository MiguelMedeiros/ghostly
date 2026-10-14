---
section: Fixed / CLI
---
- `chat history`, `group history` and `wallet history` take only a whole number for `--limit`. Before, `--limit 1.5` on a chat or a group answered code `engine` (as if the engine had failed, which a bot may retry) and `wallet history` took it; now each answers `bad_request`, "limit must be a whole number from 1 to 10000".

---
section: Fixed / CLI
---
- `file send`, `profile picture`, `group picture` and `profile backup --out` say at once that a path is not there or is a folder. Before, they opened the profile first (and a one-shot went online), so a typo in the path took about a second on a big profile before the refusal. The answer is the same as before: not found for a missing path or folder, a bad request for a folder where a file goes.

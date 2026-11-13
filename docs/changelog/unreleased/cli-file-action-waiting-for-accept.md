---
section: Fixed / CLI
---
- `ghostly file pause`, `file resume` and `file request` of a 1:1 file your contact offers that waits for `file accept` are refused with "Not taken yet: it waits for you to take it (file accept, or file decline)" and exit 1. Before, they answered as if the file was paused or asked for, with exit 0, while it still waited for your answer.

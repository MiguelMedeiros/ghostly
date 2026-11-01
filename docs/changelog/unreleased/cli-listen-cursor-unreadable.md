---
section: Fixed / CLI
---
- `ghostly listen --cursor <file>` with a cursor file that holds no event number (empty, half-written, edited by hand) stops at start with a `bad_request` naming the file and what it holds. Before, it started at the end of the event journal without a word, skipping every event since the last one handled, and its next write replaced the file.

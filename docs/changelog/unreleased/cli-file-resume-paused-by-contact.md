---
section: Fixed / CLI
---
- `ghostly file resume`, `file request` and `file resend` of a 1:1 file your contact paused are refused with "Paused by the contact: it goes on when they resume it" and exit 1. Before, they answered as if the file went on, with exit 0, while it stayed paused until the contact resumed it.

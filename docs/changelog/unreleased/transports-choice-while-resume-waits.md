---
section: Fixed / Transports
---
- A connection choice for a chat that waits its turn to come back after a restart (`ghostly chat transport`, `ghostly chat disconnect --hold`, or the same from the app's engine) now starts that chat at once and takes the choice. It was refused with "Delivery method unavailable." or "Transport unavailable" until the chat's turn came, which on a daemon with many chats live at its last run could take minutes.

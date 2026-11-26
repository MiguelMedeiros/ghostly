---
section: Fixed / Transports
---
- A file sent again or asked for again (`ghostly file resend`, `ghostly file request`) in a chat that still waits its turn to come back after a restart starts that chat at once, as it does for a chat whose connection dropped. Before, it waited for every chat ahead of it in line to come back first.

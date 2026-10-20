---
section: Fixed / Wallets
---
- With many past Lightning payments, the chat list shows sooner at start and the CLI daemon starts faster and lighter. The list of Lightning payments is now read once and reused until a payment changes; before, a start read it again 38 times. With 5,000 payments that took 0.25 s before the chat list showed (up to 0.75 s on a slow phone), plus 0.5 s and 125 MB for the daemon.

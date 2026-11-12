---
section: Fixed / CLI
---
- A profile backup keeps a chat's hold (`chat disconnect --hold`), so a chat held when it was backed up comes back to its live link after the hold. Before, the restored profile kept that chat on DHT only for good, with nothing saying why, until `chat connect` or `chat transport auto`. A hold whose time passed before the restore ends when the restored profile starts. A hold that starts or ends while the backup runs is kept too.

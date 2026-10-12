---
section: Fixed / Wallets
---
- With a long history of reviewed payments, the check that runs every 10 seconds for payments still on their way no longer reads every payment ever reviewed: it reads the ones whose outcome is still open, usually none. At 2,000 reviewed payments that was about 9 MiB read from the database every 10 seconds while the app sat idle.

---
section: Fixed / Wallets
---
- A Fedimint federation restored with a profile backup while its guardians did not answer (or you were offline) is now joined again, recovering its ecash, once they answer. Before, the failed first try left an empty client database behind: every later try opened it and failed, every 30 seconds and at each start, and the federation stayed in error until you left it and joined it again by hand.

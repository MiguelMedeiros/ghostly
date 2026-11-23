---
section: Fixed / Wallets
---
- A Fedimint federation that cannot be opened (one restored with your profile whose guardians do not answer, or you are offline) is now tried again less and less often, up to every 5 minutes, and again at once when the app comes back to the front or online. It was tried every 30 seconds for as long as the app ran. A restored one is still joined again only through its recovery, on its saved database.

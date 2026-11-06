---
section: Fixed / Wallets
---
- A Lightning card that cannot look up its invoices (an NWC connection without invoice lookup, a browser wallet without it) no longer makes invoices it could never see paid. Before, a payment to one never reached the chat request, which stayed waiting. Receiving with it now says why and what to do instead.

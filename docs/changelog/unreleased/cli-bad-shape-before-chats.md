---
section: Fixed / CLI
---
- Without a daemon, `ghostly pay`, `wallet redeem`, `wallet add-mint`, `identity add`, `group join` and `service add` refuse an argument of the wrong shape (no invoice, Lightning address or LNURL; no ecash token; no https mint URL; no such identity provider; no group link; a service not on this machine) before the profile opens. They opened it online and started every saved chat first: with 10 chats saved, each typo cost 20 relay requests and about 0.4 s more (1.4 s with 100 chats). The answer, error code and exit status are unchanged.

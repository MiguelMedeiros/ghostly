---
section: Fixed / Wallets
release: 1.14
---
- `ghostly wallet redeem` of ecash that names no http(s) mint at all (a `file:`, `data:`, `gopher:` or `ftp:` address, or no address) answers code `bad_request` with "That is not a valid ecash token", in the app too. Before, it was code `engine` with "Ecash from  is not accepted" or "Invalid URL".

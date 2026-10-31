---
section: Fixed / CLI
---
- `wallet redeem -` reads the Cashu token from stdin, as `invite join -` and `group join -` do. Before, it took the dash itself as the token: "That is not a valid ecash token", with a warning that the token was on the command line.

---
section: Fixed / Everywhere
---
- CLI: `ghostly listen --webhook` with a user or password in the URL (`http://bridge:token@127.0.0.1:8080/hook`) is now a usage error at start, which says to put the token in the path or query and does not repeat it. Such a webhook was taken, but no event ever reached it: each was held as "not answering" for good, and stderr printed the URL with the password.

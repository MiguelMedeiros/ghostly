---
section: Fixed / CLI
---
- `ghostly service add` now treats a target with a query, a fragment, a username and password, or a scheme other than http(s) as a typing mistake (`bad_request`) and names the target, instead of answering that the engine failed (`engine`).

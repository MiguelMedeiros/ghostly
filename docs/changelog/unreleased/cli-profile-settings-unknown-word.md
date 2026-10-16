---
section: Fixed / CLI
---
- `ghostly profile` and `ghostly settings`, alone or with a word they do not take, and `ghostly daemon frob`, now answer as every other group: "ghostly profile takes a command: create, list, ... (ghostly help profile)" and "Unknown command: settings frob: ghostly settings takes get or set (ghostly help settings)". `ghostly help chat histroy` (a word the group does not take) is now the same usage error as `ghostly chat histroy`, where it printed the chat group's list with exit 0.

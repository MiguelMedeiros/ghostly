---
section: Fixed / CLI
---
- `ghostly app serve --url` refuses a link a contact's app cannot read the bundle from (a host other than raw.githubusercontent.com or cdn.jsdelivr.net at a commit, a port, a space). It was kept on the app card, where the contact's install failed, and a link with a space was dropped without a word. Without `--url`, the card takes the first readable link of where the bundle was read and the manifest's sources.

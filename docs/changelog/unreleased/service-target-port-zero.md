---
section: Fixed / CLI
---
- `service add` refuses a target on port 0 (`http://127.0.0.1:0`), saying so, on the CLI and on Desktop. Before, it was added, and every contact who opened it got a failure that did not say why.

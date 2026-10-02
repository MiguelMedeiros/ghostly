---
section: Fixed / Headless
---
- The CLI's stdout holds the command's JSON answer and nothing else. Before, a note from the engine (a relay that did not answer and was left alone for a minute, for one) was printed there before the answer, and a script reading it (`ghostly wallet list | jq`) failed. Those notes now go to stderr.

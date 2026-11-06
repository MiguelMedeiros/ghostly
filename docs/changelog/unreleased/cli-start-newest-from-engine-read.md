---
section: Fixed / CLI
---
- Every one-shot command and every daemon start no longer reads each chat's and group's 100 newest messages a second time to check that the event stream is in step. Those come from the histories the start reads anyway, so a one-shot command on a profile with 200 long chats answers about a quarter of a second sooner. The events reported at start are the same as before.

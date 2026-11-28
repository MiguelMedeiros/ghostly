---
section: Fixed / CLI
---
- `ghostly engine groupCallToken` and `groupCallModerate` say why they were refused with an error code a script can branch on, instead of `engine` for every case. Not a member of the group, a group with no call server, and a call server that does not let you in (its 403) are now `refused`; a busy call server (its 429) and one that answers no pass are now `unavailable`; an act, a target or sources `groupCallModerate` does not take are now `bad_request`. The exit code stays 1 and the `--json` error keeps its shape and words. A script that retried every `engine` error should stop asking again on `refused` and `bad_request`, and wait before asking again on `unavailable`.

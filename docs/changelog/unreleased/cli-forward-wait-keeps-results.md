---
section: Fixed / CLI
---
- `ghostly forward` answers every target's result when a copy's wait ends short, and a chat or group that refused its copy still fails the command (exit 1) first. Before, a group's copy no edge took in time (a one-shot waits for one by default), or a chat's copy left waiting with `--wait sent`, failed it alone with that copy's id (exit 4): the other targets' results and refusals were lost, and a script that sent again sent twice to the targets that had theirs.

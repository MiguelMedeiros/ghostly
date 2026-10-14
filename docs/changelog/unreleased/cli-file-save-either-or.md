---
section: Fixed / CLI
---
- `ghostly file save` with both `--dir` and `--path`, or with `--timeout` but no `--wait`, and `ghostly identity complete` with both `--evidence-file` and `--stdin`, are usage errors (exit 2) naming the options, instead of one option winning without a word or `--timeout` being ignored.

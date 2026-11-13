---
section: Fixed / CLI
---
- A wait on the daemon's socket (`ghostly chat wait`, `file wait`, `--wait` on a send, edit, removal, reaction or pin, in a chat or a group) ends when its client goes away, killed or Ctrl-C'd. It stayed in the daemon to its own `--timeout`, up to a day for `chat wait`, and each retry added one more. One connection now has at most 1,024 calls open at once: the next is refused with `busy` until one answers.

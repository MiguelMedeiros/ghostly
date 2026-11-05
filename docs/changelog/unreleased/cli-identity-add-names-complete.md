---
section: Fixed / CLI
---
- `identity add` for a tool's signature (ssh-keygen, gpg, a Bitcoin wallet, a DID key) or a published record (a domain, a did:web) now ends its steps with the command that finishes the proof, `ghostly identity complete <draft>` with its draft (`--evidence-file`, or piped, for a tool's output), and says `identity share` comes next. Before, the steps were the app's: "Then press Check" and "paste it into Ghostly", with no word of `identity complete`.

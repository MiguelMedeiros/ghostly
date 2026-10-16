---
section: Fixed / CLI
---
- A required argument given as `""` (an unset variable in a script) is the same usage error as one left out (`Missing <chat>: ghostly chat show <chat>`, exit 2), before the profile opens. In 63 commands it opened the profile, then answered `bad_request` with the engine's parameter name (`chat is required`, exit 1). A path given as `""` names no file: `profile picture ""` read the current folder. `chat rename <chat> ""` still gives the chat back the contact's name.

---
section: Fixed / CLI
---
- A typo in a command or an option now says what was meant: `ghostly sned hi` answers "Unknown command: sned (did you mean send? ghostly help send)", and `ghostly send bob hi --wiat sent` "Unknown option --wiat for ghostly send (did you mean --wait? ghostly help send)". An unknown option now always names its command and its help, a command's name no longer takes in the text after it ("Unknown command: sned hi"), and "put -- before text that starts with a dash" is said only by the commands that take text, such as `send`, `edit` and `chat rename`, not by `version -x` or `chat list -x`.

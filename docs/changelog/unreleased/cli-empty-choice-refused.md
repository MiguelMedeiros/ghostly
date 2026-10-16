---
section: Fixed / CLI
---
- An empty choice, such as an unset variable in a script, is now refused, naming the choices: `wallet remove ""`, `wallet create ""`, `chat accept <chat> "" --off`, `--wait ""`, `--kind ""` and the rest. It was read as the default and acted on: `wallet remove ""` aimed at the Cashu wallet, and `chat accept <chat> "" --off` turned Cashu off for the chat.

---
section: Fixed / CLI
---
- A chat's name (`chat rename`, `invite create --label`, `invite join --label`) and the profile's name (`profile create --name`, `profile set --name`, `settings set nick`) follow the rule a group's name does: cleaned first as they are stored (a tab or a line break is a space, invisible characters are dropped), then counted, an emoji as one character. A tab was refused as a second line and a name 48 long once stored was refused at its raw length. A name with nothing that shows is refused (`bad_request`) instead of clearing the chat's name with exit 0 or being kept as an invisible profile name; an empty name still gives a chat back the contact's own.

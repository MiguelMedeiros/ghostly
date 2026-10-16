---
section: Fixed / CLI
---
- `profile backup`, `profile restore`, `profile picture`, `group picture` and `identity complete` now name the files they read as every other command does. A `--passphrase-file` or `--evidence-file` that is a folder says "<path> is a folder: name a file" (it said "the path"), `--passphrase-file ""` and `backup --out ""` (an unset variable) are refused as naming no file (they said "No such file or folder: " and "<current folder> exists"), an empty passphrase file says it is empty instead of asking for the --passphrase-file that was given, and a picture that is a folder or not readable is named as such, not "No file".

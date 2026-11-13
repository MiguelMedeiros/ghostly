---
section: Fixed / CLI
---
- A path whose symbolic links go round in a loop (`file send`, `profile picture`, `group picture`, `profile backup --out`, and any other file the CLI reads or writes) is answered not found, "No such file or folder: … (its symbolic links go round in a loop)", with exit 3. Before, Node's raw "ELOOP: too many symbolic links encountered" came back as an engine failure.

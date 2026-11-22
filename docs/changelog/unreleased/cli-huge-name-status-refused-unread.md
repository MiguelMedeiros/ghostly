---
section: Fixed / CLI
release: 1.14
---
- A name, a status or a file's name of megabytes no longer holds the daemon: a 10 MiB group name, profile name or status was cleaned whole before it was refused, and the daemon answered no other call for up to 4 seconds. A name (a group's, a chat's, the profile's, a service's) longer than 64 UTF-16 units per character of its bound, or a status text longer than 3840, is now refused at once as `bad_request`, saying its length as given (`details.given` and `details.max` for a name), even when what cleaning drops (spaces, invisible characters) would have left it short enough. A file's name is still cut, never refused: only its start and its end are read.

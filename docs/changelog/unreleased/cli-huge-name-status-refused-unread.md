---
section: Fixed / CLI
---
- A name, a status or a file's name of megabytes no longer holds the daemon: a 10 MiB group name, profile name or status was cleaned whole before it was refused, and the daemon answered no other call for up to 4 seconds. A name or status far past its length is now refused at once, saying its length as given, and a file's name is read only at its start and its end, which also ends the `engine` error a file name of over 8 MiB of letters gave.

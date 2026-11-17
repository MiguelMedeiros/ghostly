---
section: Fixed / CLI
---
- `file save --dir`, when the folder already has a file with that name, now offers a "keep both" name (`<name> (2)`) that fits the file system even when the contact's file name is very long (about 255 bytes, for example 85 Chinese characters). The name is shortened to make room for " (2)". Before, the offered name was too long, and running the offered command failed with "A name in … is too long for this file system". A voice message saved again now also gets a name of the right length.

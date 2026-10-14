---
section: For developers / CLI
---
- Profiles: `ghostly profile create <name> --name <shown name>` with a name it refuses (over 64 characters) makes no profile and leaves the current one as it was. Before, it answered the error but left the profile made, and current with `--use`, so the retry with a good name was refused "Profile <name> exists".

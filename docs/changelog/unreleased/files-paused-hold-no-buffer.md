---
section: Fixed / Everywhere
---
- A file waiting to arrive (paused, or with no connection to its sender) no longer holds memory to gather its bytes. Each file being received held 256 KiB from the moment it was accepted, so a contact who sent many small files and paused them all kept up to 64 MiB of the app's or the CLI daemon's memory until a restart.

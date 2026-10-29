---
section: Fixed / CLI
---
- When the daemon runs a newer release than the command (a second install, a project's pinned copy of the CLI), the command's warning no longer tells you to run `ghostly daemon restart`, which replaced the newer daemon with the older release and then refused the newer CLI's commands. It now says the command is older than the daemon and to upgrade the CLI (`npm install -g @ghostlytools/cli`). Versions are compared in release order (1.10.0 is newer than 1.9.0, a prerelease is older than its release), and a `ghostly daemon restart` that starts an older release than the one it stopped says so on stderr.

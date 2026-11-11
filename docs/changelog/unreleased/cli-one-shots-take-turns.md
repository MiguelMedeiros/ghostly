---
section: Fixed / CLI
---
- Several `ghostly` commands started at once on a profile with no daemon now take their turns instead of failing busy. Each waited 5 s in all for the profile, so on a busy machine the last of six reads, behind five others that each held it for a second, failed with "was not free after 5 s" while the profile was only passing from one command to the next. A command now waits 5 s for each one that holds the profile, up to a minute in all; one that keeps it longer than 5 s is still answered busy.

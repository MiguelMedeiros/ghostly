---
section: Fixed / Apps
---
- Uninstalling an app, fetching its files again, updating it or removing a built-in app reads the list of installed apps once, not twice. Each read looks for every installed app's files, so a profile with many apps did that work twice for each change.

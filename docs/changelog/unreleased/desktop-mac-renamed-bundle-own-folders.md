---
section: Fixed / Desktop
---
- On a Mac, a copy of the Desktop app given its own bundle id after it was built (a second app to test with) now keeps its own log, data and cache folders, named after that id. Before, it wrote into the main app's log and shared its data folder, while WebKit already kept each app's pages apart. On its first launch the copy starts from what the shared folder held, so the files it had are still there.

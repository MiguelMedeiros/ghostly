---
section: Fixed / Apps
---
- On the web, opening an app while the server answers the apps' sandbox page with an error of its own (a 502 while it restarts, a 429, a 408) no longer says "You are offline." It says the host had a problem, with the error number, and to try again later. Offline, or when the page could not be reached at all, it still says you are offline.

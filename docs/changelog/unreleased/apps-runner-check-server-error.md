---
section: Fixed / Apps
---
- On the web, Apps no longer disappears until a reload when the server answers the check for the apps' sandbox page with an error (a 502 while it restarts, a 503, a 429). Ghostly asks again every 30 seconds, as it does when the page could not be reached, and Apps comes back once the server answers. Opening an app during such an error no longer says the server isn't set up to run apps.

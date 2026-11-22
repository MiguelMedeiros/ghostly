---
section: Fixed / Web
---
- The web app's first visit downloads about 170 KB less (gzip) in the background, as does an update that changes that code: the group call's code and its encryption worker (640 KB) are no longer saved for offline use when the app installs, as a call only runs online. The first group call fetches them and keeps them. Desktop, Android and the browser extension are unchanged.

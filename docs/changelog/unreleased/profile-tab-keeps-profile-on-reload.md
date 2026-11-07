---
section: Fixed / Profiles
---
- In the web app, a tab keeps its profile when it reloads: after Reload on a new version in another tab, coming back from the browser's back/forward cache, or a reload by hand. Before, a tab running another profile than the last one chosen came back as that one, waited behind the tab already running it, and its own profile stopped running, its chat gone from the screen.

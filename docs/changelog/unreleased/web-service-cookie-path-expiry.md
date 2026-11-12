---
section: Fixed / Web
---
- In the web app, a contact's shared app gets its cookies back as a browser gives them: only on the paths each was set for, and no longer once it has run out. Before, every cookie went with every request for as long as the app stayed open, so one set for `/admin` reached the whole app, and a cookie meant to last a few seconds never went away.

---
section: Fixed
---
- One profile on several devices (WISP 06): a backup made before the profile had other devices, restored while Ghostly
  could not check them, now opens offline (limited mode) instead of starting a second live copy. It checks every 30
  seconds and starts by itself when no other device runs the profile, or goes on standby when one does. A line above
  the chat list says why.

---
section: Fixed
---
- One profile on several devices (WISP 06): the active device now reads which device is active every 10 minutes while
  it runs, and at once when another device's link says it holds the turn. A device that another one took over from
  while it ran stops within minutes, instead of staying active beside it until it restarted.
- Removing a device while a check of the active device was still out no longer leaves that device unable to start.

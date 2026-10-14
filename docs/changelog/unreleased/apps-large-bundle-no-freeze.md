---
section: Fixed / Apps
---
- On the web and on Desktop, installing, updating or first opening a large app no longer freezes the page while its files are checked. A 16 MiB app was checked in three runs of about 150 ms each between the tap on its listing and the app on screen, during which nothing was drawn and no input was taken, and an update taken by the background check did the same in the middle of typing or a call. The files are now checked off the page's thread, or a small piece at a time where the browser cannot do that. The same goes for a large store index and a publisher's revocation list, which were read in one run at every update check.

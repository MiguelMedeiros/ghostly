---
section: Fixed / Desktop
---
- Linux Desktop: the app no longer freezes for seconds when a sound plays after a few quiet seconds, as at a new chat's first contact. WebKitGTK before 2.52 (Ubuntu 22.04, for one) held the page for 0.5 to 16 seconds whenever it woke the sounds' audio output; there the output now stays open between sounds. WebKitGTK 2.52 and later still let it go when idle.

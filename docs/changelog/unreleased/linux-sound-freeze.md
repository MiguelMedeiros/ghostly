---
section: Fixed / Everywhere
---
- Linux Desktop: the app no longer freezes for 5 to 10 seconds when a sound plays after a few quiet seconds, as at a new chat's first contact. WebKitGTK held the page while it woke the sounds' audio output; that output is now closed between sounds and a new one opened for the next, in milliseconds.

---
section: Fixed / Groups
---
- On an app with no WebRTC (the Linux Desktop, a CLI with `GHOSTLY_WEBRTC=0`), a third private group's link lets people in again. Before, once two groups with members held the connections groups may use, anyone who opened the third group's link stayed at "invited" for good. A join now takes any free connection, or one from a group that keeps another.

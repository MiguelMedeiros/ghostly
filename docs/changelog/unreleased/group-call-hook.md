---
section: For developers / Calls
---
- The web UI can join a group call through the group's node, not reachable yet: it joins with the microphone on and the camera off (muted past 8 people), turns the microphone, camera and screen share on and off, and leaves. The call's code loads only when a call starts. A group shows it once its node turns group calls on. Each person in the call is named as the group's chat names them, by their key: two members with the same name are told apart by the end of their key, and someone not in the group is shown as not in it, never by the name the node passes along.

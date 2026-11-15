---
section: For developers / Calls
---
- The web UI can join a group call through the group's node, not reachable yet: it joins with the microphone on and the camera off (muted past 8 people), turns the microphone, camera and screen share on and off, and leaves. The call's code loads only when a call starts. A group shows it once its node turns group calls on. A group whose call asks for sealed media (`e2ee: 1`) is joined only sealed end to end, with the group's call key, set anew at each new epoch; a browser that can't seal call media, or a device without the key yet, doesn't join and says why.

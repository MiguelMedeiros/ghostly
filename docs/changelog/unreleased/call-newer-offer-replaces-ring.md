---
section: Fixed / Calls
---
- A contact who calls again while their earlier call still rings here (their app closed or reloaded mid-ring, so its hang-up never arrived) now rings with the new call, under one "Incoming call" line, and Answer connects it. Before, the new call was ignored and Answer picked up the old one: the caller saw "No answer" and this side "Call couldn't connect". When the new call is the other kind (audio or video), a screen reader hears "Now a video call" (or audio) and the keyboard focus stays in the card, never left on a button that would now answer with the camera.

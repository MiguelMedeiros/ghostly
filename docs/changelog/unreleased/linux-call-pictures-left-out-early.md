---
section: Fixed / Calls
---
- Desktop on Linux: a video call no longer makes a JPEG of every picture the contact sends. The page is shown at most 15 a second and a browser sends 30, so more than half were scaled, made a JPEG and then thrown away. They are now left out as they are decoded. Showing a contact's 640x480 picture took 6.6% of a core and now takes 3.0%; at 1280x720 it took 37% and now takes 23%.

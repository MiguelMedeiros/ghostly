---
section: Fixed / Apps
---
- An app that talks a lot with the contact's app (a game sending many frames a second) costs the chat less: each frame it sent made Ghostly derive the chat's own key from its seed again, only to name the app to the contact, about 0.6 ms a frame and 30 ms of every second at the 48 frames a second an app may send. The key the chat already keeps is used, and a frame now takes about 0.02 ms to name.
